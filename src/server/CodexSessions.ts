// Codex sessions that ran outside T3, read through `codex app-server` (thread/list, thread/read).
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as CodexClient from "../codex-app-server/client.ts";
import { ThreadNotFound } from "../core/api.ts";
import {
  CodexThreadListPage,
  CodexThreadRead,
  codexThreadToRows,
  isoFromSeconds,
  scanItemTimes,
  type CodexThreadMeta,
} from "../core/codex.ts";
import type { Labels, ThreadHead, ThreadSummary, ThreadView } from "../core/domain.ts";
import { normalize } from "../core/normalize.ts";
import { ServerConfig } from "./ServerConfig.ts";
import { ThreadStore, type T3Project } from "./ThreadStore.ts";

/** Top-level sessions; subagent threads are reached through their parent. */
const SOURCE_KINDS = ["cli", "vscode", "exec", "appServer", "unknown"];
const PAGE_SIZE = 200;
/** No live status for sessions owned by other processes: recently written counts as running. */
const RUNNING_WITHIN_MS = 120_000;
export const CODEX_ID_PREFIX = "codex:";

export type CodexSessionsOptions = {
  /** How long `codex app-server` gets to answer `initialize` before the source is disabled. */
  readonly initTimeout: Duration.Input;
  readonly requestTimeout: Duration.Input;
  /** Incremental refresh: only threads updated since the last one. */
  readonly refreshEvery: Duration.Input;
  /** Every Nth refresh re-lists everything, so sessions deleted elsewhere disappear. */
  readonly fullRefreshEvery: number;
};

const DEFAULTS: CodexSessionsOptions = {
  initTimeout: Duration.seconds(15),
  requestTimeout: Duration.seconds(60),
  refreshEvery: Duration.seconds(20),
  fullRefreshEvery: 15,
};

type ThreadMeta = Omit<CodexThreadMeta, "turns"> & { readonly archived: boolean };

const decodeListPage = Schema.decodeUnknownEffect(CodexThreadListPage);
const decodeThreadRead = Schema.decodeUnknownEffect(CodexThreadRead);

export class CodexSessions extends Context.Service<
  CodexSessions,
  {
    readonly list: Effect.Effect<ReadonlyArray<ThreadSummary>>;
    /** Completes once the first full listing has landed (or failed), so callers can rely on `list`. */
    readonly ready: Effect.Effect<void>;
    /** `id` is the bare Codex thread id (without the `codex:` prefix). */
    readonly get: (id: string, labels: Labels) => Effect.Effect<ThreadView, ThreadNotFound>;
    readonly head: (id: string) => Effect.Effect<ThreadHead, ThreadNotFound>;
  }
>()("toolreader/server/CodexSessions") {
  static readonly layer = CodexSessions.layerWith(DEFAULTS);

  static layerWith(options: CodexSessionsOptions) {
    return Layer.effect(
      CodexSessions,
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const store = yield* ThreadStore;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

        // Startup gets its own scope: if Codex hangs or fails, closing it kills the child process.
        const startScope = yield* Scope.fork(yield* Effect.scope);
        const started = yield* Effect.gen(function* () {
          const child = yield* spawner.spawn(ChildProcess.make(config.codexBin, ["app-server"]));
          const context = yield* Layer.build(CodexClient.layerChildProcess(child));
          const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
            Effect.provide(context),
          );
          yield* client.request("initialize", {
            clientInfo: { name: "toolreader", title: "toolreader", version: "0.0.0" },
            capabilities: { experimentalApi: true },
          });
          yield* client.notify("initialized", undefined);
          return client;
        }).pipe(
          Scope.provide(startScope),
          Effect.timeout(options.initTimeout),
          Effect.tapCause((cause) =>
            Effect.logWarning(
              `Codex sessions disabled: could not start \`${config.codexBin} app-server\``,
              cause,
            ),
          ),
          Effect.option,
        );

        if (Option.isNone(started)) {
          yield* Scope.close(startScope, Exit.void);
          const missing = (id: string) =>
            Effect.fail(new ThreadNotFound({ threadId: `${CODEX_ID_PREFIX}${id}` }));
          return CodexSessions.of({
            list: Effect.succeed([]),
            get: missing,
            head: missing,
            ready: Effect.void,
          });
        }
        const client = started.value;
        // Raw requests + loose schemas: a strict decode of the whole protocol would fail on every new Codex field.
        const request = (method: string, params: unknown) =>
          client.raw.request(method, params).pipe(Effect.timeout(options.requestTimeout));

        let threads = new Map<string, ThreadMeta>();

        /** Pages through thread/list newest-updated first, stopping once a page is older than `since`. */
        const fetchThreads = Effect.fn("CodexSessions.fetchThreads")(function* (
          into: Map<string, ThreadMeta>,
          archived: boolean,
          since: number,
        ) {
          let cursor: string | null | undefined;
          do {
            const page = yield* request("thread/list", {
              limit: PAGE_SIZE,
              sourceKinds: SOURCE_KINDS,
              archived,
              sortKey: "updated_at",
              ...(cursor ? { cursor } : {}),
            }).pipe(Effect.flatMap(decodeListPage));
            for (const t of page.data) into.set(t.id, { ...t, archived });
            if (page.data.some((t) => t.updatedAt < since)) break;
            cursor = page.nextCursor;
          } while (cursor);
        });

        let newestSeen = 0;
        let refreshes = 0;
        const refresh = Effect.gen(function* () {
          // Full refreshes build a fresh map and swap it in, dropping sessions deleted elsewhere.
          const full = refreshes++ % options.fullRefreshEvery === 0;
          const into = full ? new Map<string, ThreadMeta>() : threads;
          const since = full ? 0 : newestSeen - 60;
          yield* fetchThreads(into, false, since);
          yield* fetchThreads(into, true, since);
          threads = into;
          for (const t of threads.values()) newestSeen = Math.max(newestSeen, t.updatedAt);
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("Codex thread/list failed", cause)));

        // The first (full) load pages through everything and takes a few seconds, so it runs in the background.
        const firstLoad = yield* Deferred.make<void>();
        yield* refresh.pipe(
          Effect.andThen(Deferred.succeed(firstLoad, undefined)),
          Effect.andThen(refresh.pipe(Effect.repeat(Schedule.spaced(options.refreshEvery)))),
          Effect.forkScoped,
        );

        const projectFor = (projects: ReadonlyArray<T3Project>, cwd: string | null | undefined) => {
          const match = cwd
            ? projects
                .filter((p) => cwd === p.root || cwd.startsWith(`${p.root}/`))
                .sort((a, b) => b.root.length - a.root.length)[0]
            : undefined;
          if (match) return { projectId: match.id, projectTitle: match.title };
          return { projectId: `cwd:${cwd ?? "?"}`, projectTitle: cwd ? path.basename(cwd) : "?" };
        };

        const summarize = (
          t: ThreadMeta,
          projects: ReadonlyArray<T3Project>,
          now: number,
        ): ThreadSummary => ({
          id: `${CODEX_ID_PREFIX}${t.id}`,
          source: "codex",
          origin: t.originator ?? null,
          title: (t.name ?? t.preview ?? "").split("\n")[0]!.slice(0, 160) || "(untitled)",
          ...projectFor(projects, t.cwd),
          provider: "codex",
          status: now - t.updatedAt * 1000 < RUNNING_WITHIN_MS ? "running" : "idle",
          archived: t.archived,
          updatedAt: isoFromSeconds(t.updatedAt),
          actionCount: null,
          worktree: t.cwd ?? null,
        });

        const list = Effect.gen(function* () {
          const [owned, projects, now] = yield* Effect.all([
            store.codexThreadIds,
            store.projects,
            Clock.currentTimeMillis,
          ]);
          return [...threads.values()]
            .filter((t) => !owned.has(t.id) && !t.parentThreadId && !t.ephemeral)
            .map((t) => summarize(t, projects, now));
        }).pipe(Effect.withSpan("CodexSessions.list"));

        const notFound = (id: string) =>
          new ThreadNotFound({ threadId: `${CODEX_ID_PREFIX}${id}` });

        /** Size + mtime of the rollout file: changes whenever the session writes anything. */
        const fileHead = (file: string | null | undefined) =>
          file
            ? fs.stat(file).pipe(
                Effect.map((s) => ({
                  head: `${s.size}:${Option.getOrElse(
                    Option.map(s.mtime, (d) => d.getTime()),
                    () => 0,
                  )}`,
                  mtime: Option.getOrElse(
                    Option.map(s.mtime, (d) => d.getTime()),
                    () => 0,
                  ),
                })),
                Effect.orElseSucceed(() => ({ head: "", mtime: 0 })),
              )
            : Effect.succeed({ head: "", mtime: 0 });

        const head = Effect.fn("CodexSessions.head")(function* (id: string) {
          const t = threads.get(id);
          if (!t) return yield* notFound(id);
          const { head, mtime } = yield* fileHead(t.path);
          const now = yield* Clock.currentTimeMillis;
          return {
            head,
            status: now - mtime < RUNNING_WITHIN_MS ? ("running" as const) : ("idle" as const),
          };
        });

        const itemTimes = (file: string | null | undefined) =>
          file
            ? fs.stream(file).pipe(
                Stream.decodeText(),
                Stream.splitLines,
                Stream.runFold(
                  () => new Map<string, string>(),
                  (times, line) => scanItemTimes([line], times),
                ),
                Effect.orElseSucceed(() => new Map<string, string>()),
              )
            : Effect.succeed(new Map<string, string>());

        const get = Effect.fn("CodexSessions.get")(function* (id: string, labels: Labels) {
          // Marker first: if the session writes while we read, the next poll sees a newer marker
          // and refetches, instead of the UI keeping stale entries under a fresh marker.
          const knownPath = threads.get(id)?.path;
          const before = yield* fileHead(knownPath);
          const read = yield* request("thread/read", { threadId: id, includeTurns: true }).pipe(
            Effect.flatMap(decodeThreadRead),
            Effect.catchTags({ SchemaError: Effect.die, TimeoutError: Effect.die }),
            Effect.mapError(() => notFound(id)),
          );
          // Turns hold every tool output; only metadata is cached.
          const { turns: _turns, ...thread } = read.thread;
          const meta: ThreadMeta = { ...thread, archived: threads.get(id)?.archived ?? false };
          threads.set(id, meta);
          const [times, projects, now, marker] = yield* Effect.all([
            itemTimes(read.thread.path),
            store.projects,
            Clock.currentTimeMillis,
            knownPath
              ? Effect.succeed(before.head)
              : Effect.map(fileHead(read.thread.path), (h) => h.head),
          ]);
          const { activities, messages } = codexThreadToRows(read, times);
          const entries = normalize(activities, messages, {
            root: read.thread.cwd ?? null,
            home: config.home,
          });
          return {
            thread: {
              ...summarize(meta, projects, now),
              actionCount: entries.filter((e) => e.type === "action").length,
              head: marker,
            },
            entries,
            labels,
          };
        });

        return CodexSessions.of({ list, get, head, ready: Deferred.await(firstLoad) });
      }),
    );
  }
}
