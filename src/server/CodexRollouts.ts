// Codex sessions read straight from rollout files under $CODEX_HOME, with no T3 and no
// `codex app-server` (e.g. CI after `codex exec`). Entries match the app-server path; see
// core/rolloutThread.ts. Ids share the `codex:` prefix, so labels and ledger entries line up.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { ThreadNotFound } from "../core/api.ts";
import { codexThreadToRows, isoFromSeconds } from "../core/codex.ts";
import type { Labels, ThreadSummary, ThreadView } from "../core/domain.ts";
import { normalize } from "../core/normalize.ts";
import { readRollout, rolloutMeta } from "../core/rolloutThread.ts";
import { CODEX_ID_PREFIX } from "./CodexSessions.ts";
import { ServerConfig } from "./ServerConfig.ts";
import { ThreadStore } from "./ThreadStore.ts";

/** Where Codex keeps rollout files, under its home. */
export const ROLLOUT_DIRS = ["sessions", "archived_sessions"];
const ROLLOUT = /(?:^|\/)rollout-[^/]*\.jsonl$/;

export class CodexRollouts extends Context.Service<
  CodexRollouts,
  {
    /** Top-level sessions T3 doesn't own, from each file's first line. Empty without `$CODEX_HOME`. */
    readonly list: Effect.Effect<ReadonlyArray<ThreadSummary>>;
    /** `id` is the bare Codex thread id (without the `codex:` prefix). */
    readonly get: (id: string, labels: Labels) => Effect.Effect<ThreadView, ThreadNotFound>;
  }
>()("toolreader/server/CodexRollouts") {
  static readonly layer = Layer.effect(
    CodexRollouts,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const store = yield* ThreadStore;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      /** Thread id → rollout file, filled by `list`. */
      const files = new Map<string, { file: string; archived: boolean }>();

      const summary = (
        id: string,
        cwd: string | null,
        originator: string | null,
        title: string,
        archived: boolean,
        updatedAt: number,
      ): ThreadSummary => ({
        id: `${CODEX_ID_PREFIX}${id}`,
        source: "codex",
        origin: originator,
        title,
        projectId: `cwd:${cwd ?? "?"}`,
        projectTitle: cwd ? path.basename(cwd) : "?",
        provider: "codex",
        status: "idle",
        archived,
        updatedAt: isoFromSeconds(updatedAt),
        actionCount: null,
        worktree: cwd,
      });

      const firstLine = (file: string) =>
        fs.stream(file).pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runHead,
          Effect.map(Option.getOrElse(() => "")),
          Effect.orElseSucceed(() => ""),
        );

      const list = Effect.gen(function* () {
        const owned = yield* store.codexThreadIds;
        const found: Array<{ file: string; archived: boolean }> = [];
        for (const dir of ROLLOUT_DIRS) {
          const root = path.join(config.codexHome, dir);
          const names = yield* fs
            .readDirectory(root, { recursive: true })
            .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
          for (const name of names)
            if (ROLLOUT.test(name))
              found.push({ file: path.join(root, name), archived: dir !== "sessions" });
        }
        const summaries = yield* Effect.forEach(
          found,
          ({ file, archived }) =>
            Effect.gen(function* () {
              const meta = rolloutMeta(yield* firstLine(file));
              if (!meta || meta.subagent || owned.has(meta.id)) return [];
              files.set(meta.id, { file, archived });
              const mtime = yield* fs.stat(file).pipe(
                Effect.map((s) => Option.getOrUndefined(s.mtime)?.getTime() ?? 0),
                Effect.orElseSucceed(() => 0),
              );
              const updatedAt = Math.max(meta.createdAt, Math.floor(mtime / 1000));
              return [
                summary(meta.id, meta.cwd, meta.originator, "(untitled)", archived, updatedAt),
              ];
            }),
          { concurrency: 16 },
        );
        return summaries.flat();
      }).pipe(Effect.withSpan("CodexRollouts.list"));

      const get = Effect.fn("CodexRollouts.get")(function* (id: string, labels: Labels) {
        if (!files.has(id)) yield* list;
        const known = files.get(id);
        const text = known
          ? yield* fs.readFileString(known.file).pipe(Effect.option)
          : Option.none<string>();
        const session =
          known && Option.isSome(text) ? readRollout(text.value.split("\n"), known.file) : null;
        if (!known || !session)
          return yield* new ThreadNotFound({ threadId: `${CODEX_ID_PREFIX}${id}` });
        const t = session.read.thread;
        const { activities, messages } = codexThreadToRows(session.read, session.scan);
        const entries = normalize(activities, messages, { root: t.cwd ?? null, home: config.home });
        const title = (t.preview ?? "").split("\n")[0]!.slice(0, 160) || "(untitled)";
        return {
          thread: {
            ...summary(
              t.id,
              t.cwd ?? null,
              t.originator ?? null,
              title,
              known.archived,
              t.updatedAt,
            ),
            actionCount: entries.filter((e) => e.type === "action").length,
            head: String(t.updatedAt),
          },
          entries,
          labels,
        };
      });

      return CodexRollouts.of({ list, get });
    }),
  );
}
