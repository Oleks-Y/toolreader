// `history sync`: the agent history of a range of commits, linked by content (core/history.ts)
// and sent to the backend. Each linked thread goes whole, once (only when it grew since the
// backend last had it); each commit's links replace what the backend had for it, so linking a
// range again after a split or rebase corrects it.
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import packageJson from "../../../package.json" with { type: "json" };
import { addedLines, lineKey, linkByContent, type CommitLines } from "../../core/history.ts";
import { LIMITS } from "../../core/historyApi.ts";
import {
  buildCommitRecord,
  buildThreadRecord,
  CommitRecordV1,
  ThreadRecordV1,
  type CommitRecord,
  type ThreadRecord,
} from "../../core/historyRecord.ts";
import { remoteWebUrl, SESSION_TRAILER } from "../../core/ledger.ts";
import { redactor } from "../../core/proof.ts";
import { threadSha } from "../recordHash.ts";
import { RepoSessions, type SessionSource } from "../RepoSessions.ts";
import { ServerConfig } from "../ServerConfig.ts";
import { backendSettings, call, connect, HistoryFailed } from "./HistoryClient.ts";

/** Field separator for `git show --format`, before the subject (which may hold anything). */
const US = "\u001f";
/** A full commit id: what may be passed to git as a revision without being read as an option. */
const HEX = /^[0-9a-f]{40,64}$/;
/** A record as JSON sends it: fields the redactor left `undefined` are gone. */
const asJson = <A, I>(schema: Schema.Codec<A, I>) => {
  const encode = Schema.encodeSync(Schema.fromJsonString(schema));
  return (record: A): unknown => decodeJson(encode(record));
};
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const threadJson = asJson(ThreadRecordV1);
const commitJson = asJson(CommitRecordV1);

/** Bytes kept per action output, head and tail. */
const MAX_OUTPUT = 8192;

export type SyncOptions = {
  readonly source: SessionSource;
  /** Link and report, send nothing. */
  readonly dryRun: boolean;
};

export type SyncReport = {
  readonly repo: string;
  readonly commits: ReadonlyArray<{
    readonly record: CommitRecord;
    readonly titles: ReadonlyMap<string, string>;
  }>;
  /** Threads sent, and threads the backend had as they are. */
  readonly sent: number;
  readonly unchanged: number;
};

export class HistorySync extends Context.Service<
  HistorySync,
  {
    readonly sync: (
      repo: string,
      range: string,
      options: SyncOptions,
    ) => Effect.Effect<SyncReport, HistoryFailed>;
  }
>()("toolreader/server/history/HistorySync") {
  static readonly layer = Layer.effect(
    HistorySync,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const sessions = yield* RepoSessions;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;

      /** git in `repo`; `ok` exit codes besides 0 (`git grep` exits 1 when nothing matched). */
      const git = (repo: string, args: ReadonlyArray<string>, ok: ReadonlyArray<number> = []) =>
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(ChildProcess.make("git", ["-C", repo, ...args]));
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
              handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          if (exitCode !== ChildProcessSpawner.ExitCode(0) && !ok.includes(exitCode))
            return yield* new HistoryFailed({
              message: `git ${args[0]}: ${stderr.trim() || `exit ${exitCode}`}`,
            });
          return stdout;
        }).pipe(
          Effect.scoped,
          Effect.catchTag("PlatformError", (e) =>
            Effect.fail(new HistoryFailed({ message: e.message })),
          ),
        );

      /**
       * Of `keys` (`lineKey`s), the ones the tree at `rev` already holds as a line. Every text line
       * of the tree streams through once: `git grep` given the lines as patterns takes minutes.
       */
      const presentIn = Effect.fn("HistorySync.presentIn")(
        function* (repo: string, rev: string, keys: ReadonlySet<string>) {
          const found = new Set<string>();
          if (!HEX.test(rev))
            return yield* new HistoryFailed({ message: `not a commit id: ${rev.slice(0, 80)}` });
          if (keys.size === 0) return found;
          const handle = yield* spawner.spawn(
            ChildProcess.make("git", [
              "-C",
              repo,
              "grep",
              "-h",
              "-I",
              "--no-color",
              "-e",
              "",
              rev,
              "--",
            ]),
          );
          yield* handle.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((line) =>
              Effect.sync(() => {
                const key = lineKey(line);
                if (keys.has(key)) found.add(key);
              }),
            ),
          );
          yield* handle.exitCode;
          return found;
        },
        Effect.scoped,
        Effect.mapError((e) => new HistoryFailed({ message: e.message })),
      );

      /** The range's commits, oldest first, each with the lines it adds that its parent lacked. */
      /**
       * The range's commits, oldest first, each with the lines it adds that its parent lacked. Each
       * commit's metadata is read on its own, the subject last: a subject can hold any character,
       * and must never shift another field (a parent read as a `git grep` option). A merge adds no
       * lines of its own (its parents' commits carry them), so it links nothing.
       */
      const commitsIn = Effect.fn("HistorySync.commitsIn")(function* (repo: string, range: string) {
        const shas = (yield* git(repo, [
          "rev-list",
          "--reverse",
          ...range.split(/\s+/).filter(Boolean),
        ]))
          .split("\n")
          .filter((s) => HEX.test(s));
        const commits: Array<CommitLines & { readonly subject: string }> = [];
        for (const sha of shas) {
          const [parents = "", committedAt = "", ...rest] = (yield* git(repo, [
            "show",
            "-s",
            `--format=%P${US}%cI${US}%s`,
            sha,
          ]))
            .trimEnd()
            .split(US);
          const subject = rest.join(US);
          const trailers = yield* git(repo, [
            "show",
            "-s",
            `--format=%(trailers:key=${SESSION_TRAILER},valueonly,separator=%x1e)`,
            sha,
          ]);
          const diff = yield* git(repo, [
            "diff-tree",
            "-p",
            "-U0",
            "--no-color",
            "--no-ext-diff",
            "--root",
            sha,
          ]);
          const added = new Set(addedLines(diff));
          const parent = parents.split(" ")[0];
          const present = parent ? yield* presentIn(repo, parent, added) : new Set<string>();
          commits.push({
            sha,
            subject,
            committedAt,
            trailers: trailers
              .split("\u001e")
              .map((t) => t.trim())
              .filter(Boolean),
            novel: [...added].filter((l) => !present.has(l)),
          });
        }
        return commits;
      });

      const sync = Effect.fn("HistorySync.sync")(function* (
        repoArg: string,
        range: string,
        options: SyncOptions,
      ) {
        const repo = (yield* git(repoArg, ["rev-parse", "--show-toplevel"])).trim();
        const origin = (yield* git(repo, ["remote", "get-url", "origin"], [2])).trim();
        const web = remoteWebUrl(origin || null);
        if (!web)
          return yield* new HistoryFailed({
            message: `${repo} has no origin on a git host: the backend names repos owner/name`,
          });
        const repoName = new URL(web).pathname.slice(1);
        const commits = yield* commitsIn(repo, range);
        const loaded = yield* sessions
          .load(repo, options.source)
          .pipe(Effect.mapError((e) => new HistoryFailed({ message: e.message })));
        const histories = linkByContent(
          commits,
          loaded.sessions.map((s) => ({ id: s.thread.id, entries: s.entries })),
          (name) => loaded.named(name).map((s) => s.thread.id),
        );
        const now = DateTime.formatIso(yield* DateTime.now);
        const records = histories.map((history, i) =>
          buildCommitRecord({
            repo: repoName,
            subject: commits[i]!.subject,
            committedAt: commits[i]!.committedAt,
            history,
            linkedAt: now,
            toolreaderVersion: packageJson.version,
            home: config.home,
          }),
        );
        const byId = new Map(loaded.sessions.map((s) => [s.thread.id, s]));
        const linked = [...new Set(records.flatMap((r) => r.links.map((l) => l.threadId)))];
        // Titles are first prompt lines: reports go to logs, so redacted, home as `~`.
        const { clean } = redactor(config.home);
        const titles = new Map(linked.map((id) => [id, clean(byId.get(id)?.thread.title ?? id)]));
        const report = (sent: number, unchanged: number): SyncReport => ({
          repo: repoName,
          commits: records.map((record) => ({ record, titles })),
          sent,
          unchanged,
        });
        if (options.dryRun) return report(0, 0);

        const threads: ThreadRecord[] = linked.flatMap((id) => {
          const s = byId.get(id);
          return s
            ? [
                buildThreadRecord({
                  thread: s.thread,
                  entries: s.entries,
                  labels: s.labels,
                  takenAt: now,
                  toolreaderVersion: packageJson.version,
                  maxOutput: MAX_OUTPUT,
                  home: config.home,
                }),
              ]
            : [];
        });
        const settings = yield* backendSettings().pipe(
          Effect.provideService(ServerConfig, config),
          Effect.provideService(FileSystem.FileSystem, fs),
        );
        const api = yield* connect(settings).pipe(Effect.provide(FetchHttpClient.layer));
        const params = { ws: settings.workspace };
        const stored = new Map<string, string>();
        for (let i = 0; i < threads.length; i += LIMITS.ids) {
          const ids = threads.slice(i, i + LIMITS.ids).map((t) => t.thread.id);
          const { hashes } = yield* call(api.history.hashes({ params, payload: { ids } }));
          for (const [id, sha] of Object.entries(hashes)) stored.set(id, sha);
        }
        let sent = 0;
        for (const thread of threads) {
          if (stored.get(thread.thread.id) === threadSha(thread)) continue;
          yield* call(api.history.putThread({ params, payload: threadJson(thread) }));
          sent++;
        }
        // Links last: a commit names only threads the backend has.
        for (const record of records)
          yield* call(api.history.putCommit({ params, payload: commitJson(record) }));
        return report(sent, threads.length - sent);
      }, Effect.provide(FetchHttpClient.layer));

      return HistorySync.of({ sync });
    }),
  );
}
