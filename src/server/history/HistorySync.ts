// `history sync`: the agent history of a range of commits, linked by content (core/history.ts)
// and sent to the backend; `history site`: that history read back, as one page. Each linked thread goes whole, once (only when it grew since the
// backend last had it); each commit's links replace what the backend had for it, so linking a
// range again after a split or rebase corrects it.
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import packageJson from "../../../package.json" with { type: "json" };
import {
  applyDeclarations,
  declarationsIn,
  turnIds,
  type Declared,
  type ResolvedDeclaration,
} from "../../core/declare.ts";
import { checksFor } from "../../core/checks.ts";
import { readsFor } from "../../core/coverage.ts";
import { addedLines, lineKey, linkByContent, type CommitLines } from "../../core/history.ts";
import { LIMITS, type Evidence, type SearchHit } from "../../core/historyApi.ts";
import type { Finding, FindingStatus } from "../../core/insights.ts";
import type { EvidenceNow, ReviewManifest } from "../../core/review.ts";
import {
  buildCommitRecord,
  buildThreadRecord,
  CommitRecordV1,
  ThreadRecordV1,
  type CommitRecord,
  type ThreadRecord,
} from "../../core/historyRecord.ts";
import { historyRange } from "../../core/historyPage.ts";
import { remoteWebUrl, repoKey, SESSION_TRAILER, type LedgerRange } from "../../core/ledger.ts";
import { ledgerSiteHtml, publicRange } from "../../core/ledgerSite.ts";
import { redactor } from "../../core/proof.ts";
import { threadSha } from "../recordHash.ts";
import { RepoSessions, type RepoSession, type SessionSource } from "../RepoSessions.ts";
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
  /** Declarations about this range that couldn't be applied, and why. */
  readonly ignored: ReadonlyArray<string>;
  /** Sessions in this repo that couldn't be read, so weren't linked (titles redacted). */
  readonly unread: ReadonlyArray<{ readonly id: string; readonly title: string }>;
};

export class HistorySync extends Context.Service<
  HistorySync,
  {
    readonly sync: (
      repo: string,
      range: string,
      options: SyncOptions,
    ) => Effect.Effect<SyncReport, HistoryFailed>;
    /** Entries the backend holds with `text`: this repo's threads, or the workspace's (`all`). */
    readonly search: (
      repo: string,
      text: string,
      options: { readonly all: boolean; readonly limit: number },
    ) => Effect.Effect<
      { readonly hits: ReadonlyArray<SearchHit>; readonly truncated: boolean },
      HistoryFailed
    >;
    /** Runs the Insights detectors on the backend over this repo's history, then lists findings. */
    readonly insights: (
      repo: string,
      options: { readonly detect: boolean; readonly statuses?: ReadonlyArray<FindingStatus> },
    ) => Effect.Effect<
      { readonly findings: ReadonlyArray<Finding>; readonly added: number | null },
      HistoryFailed
    >;
    /** A citation (`thread#entry@version`) read back from the backend, scoped to this repo. */
    readonly show: (repo: string, cite: string) => Effect.Effect<Evidence, HistoryFailed>;
    /** Freezes a review of the range's commits on the backend. */
    readonly freezeReview: (
      repo: string,
      range: string,
      decision: { readonly verdict: ReviewManifest["decision"]["verdict"]; readonly note: string },
    ) => Effect.Effect<ReviewManifest, HistoryFailed>;
    /** A frozen review, as it was, with what each cited session is now. */
    readonly review: (
      repo: string,
      id: string,
    ) => Effect.Effect<
      {
        readonly manifest: ReviewManifest;
        readonly now: ReadonlyArray<{ readonly threadId: string; readonly status: EvidenceNow }>;
      },
      HistoryFailed
    >;
    /** Moves one of this repo's findings along its lifecycle. */
    readonly decide: (
      repo: string,
      id: string,
      to: FindingStatus,
      why: string,
    ) => Effect.Effect<Finding, HistoryFailed>;
    /** The range's page (the ledger viewer, inlined) from what the backend has; writes `out/index.html`. */
    readonly site: (
      repo: string,
      range: string,
      out: string,
    ) => Effect.Effect<{ readonly file: string; readonly view: LedgerRange }, HistoryFailed>;
  }
>()("toolreader/server/history/HistorySync") {
  static readonly layer = Layer.effect(
    HistorySync,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const sessions = yield* RepoSessions;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

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

      /** A commit's `git patch-id --stable`, or null (a merge, or not in the repo). */
      const patchId = (repo: string, sha: string) =>
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make("sh", [
              "-c",
              'git -C "$1" show --no-color "$2" | git patch-id --stable',
              "sh",
              repo,
              sha,
            ]),
          );
          const out = yield* handle.stdout.pipe(Stream.decodeText(), Stream.mkString);
          yield* handle.exitCode;
          return out.split(" ")[0]?.trim() || null;
        }).pipe(
          Effect.scoped,
          Effect.orElseSucceed(() => null),
        );

      /**
       * Each declaration about a commit of the range, with its SHA, thread and turn ids resolved.
       * A SHA a rebase or amend replaced is followed by patch-id. What can't be resolved is reported.
       */
      const resolveDeclarations = Effect.fn("HistorySync.resolveDeclarations")(function* (
        repo: string,
        commits: ReadonlyArray<{ readonly sha: string; readonly subject: string }>,
        declared: ReadonlyArray<Declared>,
        named: (name: string) => ReadonlyArray<RepoSession>,
      ) {
        const resolved: ResolvedDeclaration[] = [];
        const ignored: string[] = [];
        const shas = commits.map((c) => c.sha);
        let patchIds: Map<string, string> | null = null;
        for (const d of declared) {
          let sha = shas.find((s) => s.startsWith(d.sha)) ?? null;
          if (!sha) {
            // Not in the range as declared: rewritten since (same patch), or another range's.
            const known = yield* git(
              repo,
              ["rev-parse", "--verify", "-q", `${d.sha}^{commit}`],
              [1],
            );
            const pid = known.trim() ? yield* patchId(repo, known.trim()) : null;
            if (!pid) continue;
            patchIds ??= new Map(
              (yield* Effect.forEach(shas, (s) =>
                Effect.map(patchId(repo, s), (p) => [p, s] as const),
              )).flatMap(([p, s]) => (p ? [[p, s] as const] : [])),
            );
            sha = patchIds.get(pid) ?? null;
            if (!sha) continue;
          }
          const target = d.session ? named(d.session)[0] : named(d.by)[0];
          const where = `${d.kind} ${sha.slice(0, 8)} (declared in turn ${d.turn} of ${d.by})`;
          if (!target) {
            ignored.push(`${where}: no session ${d.session ?? d.by} worked in this repo`);
            continue;
          }
          const turns = turnIds(target.entries, d.turns ?? []);
          if (d.kind === "link" && turns.length === 0) {
            ignored.push(
              `${where}: its turns ${d.turns?.join(",") ?? "(none named)"} aren't in that session`,
            );
            continue;
          }
          resolved.push({
            kind: d.kind,
            sha,
            threadId: target.thread.id,
            turns,
            note: d.note,
            by: named(d.by)[0]?.thread.id ?? d.by,
            at: d.at,
          });
        }
        return { resolved, ignored };
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
        const repoName = repoKey(web);
        const commits = yield* commitsIn(repo, range);
        const loaded = yield* sessions
          .load(repo, options.source)
          .pipe(Effect.mapError((e) => new HistoryFailed({ message: e.message })));
        const matched = linkByContent(
          commits,
          loaded.sessions.map((s) => ({ id: s.thread.id, entries: s.entries })),
          (name) => loaded.named(name).map((s) => s.thread.id),
        );
        // What agents declared (`history link`), found in their sessions, applied over that.
        const declared = loaded.sessions.flatMap((s) => declarationsIn(s.thread.id, s.entries));
        const { resolved, ignored } = yield* resolveDeclarations(repo, commits, declared, (name) =>
          loaded.named(name),
        );
        const byId = new Map(loaded.sessions.map((s) => [s.thread.id, s]));
        // Each link with the tests and builds its session ran for that commit.
        const histories = matched.map((h, i) => {
          const { novel, committedAt, sha } = commits[i]!;
          const history = applyDeclarations(h, resolved);
          const keys = new Set(novel);
          // When each linked session first wrote one of the commit's lines.
          const wrote = new Map(
            history.links.map((l) => {
              const times = (byId.get(l.threadId)?.entries ?? []).flatMap((e) =>
                e.type === "action" &&
                (e.files ?? []).some((f) =>
                  (f.addedKeys ?? (f.diff ? addedLines(f.diff) : [])).some((k) => keys.has(k)),
                )
                  ? [Date.parse(e.at)]
                  : [],
              );
              return [l.threadId, times] as const;
            }),
          );
          return {
            ...history,
            links: history.links.map((l) => {
              const s = byId.get(l.threadId);
              const others = history.links
                .filter((o) => o.threadId !== l.threadId)
                .flatMap((o) => wrote.get(o.threadId) ?? []);
              const checks = s
                ? checksFor({
                    entries: s.entries,
                    turns: l.turns,
                    novel,
                    committedAt,
                    sha,
                    base: s.snapshot?.startCommit,
                    others,
                  })
                : [];
              const reads = s
                ? readsFor({ entries: s.entries, turns: l.turns, committedAt })
                : null;
              return {
                ...l,
                ...(checks.length > 0 ? { checks } : {}),
                ...(reads && reads.paths.length > 0 ? { reads } : {}),
              };
            }),
          };
        });
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
        const linked = [...new Set(records.flatMap((r) => r.links.map((l) => l.threadId)))];
        // Titles are first prompt lines: reports go to logs, so redacted, home as `~`.
        const { clean } = redactor(config.home);
        const titles = new Map(linked.map((id) => [id, clean(byId.get(id)?.thread.title ?? id)]));
        const report = (sent: number, unchanged: number): SyncReport => ({
          repo: repoName,
          commits: records.map((record) => ({ record, titles })),
          sent,
          unchanged,
          ignored,
          unread: loaded.unread.map((u) => ({ id: u.id, title: clean(u.title) })),
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
                  snapshot: s.snapshot,
                  origin: s.origin,
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
          // `same`: the backend had it, or won't keep it (deleted on request): not sent as new.
          const { result } = yield* call(
            api.history.putThread({ params, payload: threadJson(thread) }),
          );
          if (result !== "same") sent++;
        }
        // Links last: a commit names only threads the backend has.
        for (const record of records)
          yield* call(api.history.putCommit({ params, payload: commitJson(record) }));
        return report(sent, threads.length - sent);
      }, Effect.provide(FetchHttpClient.layer));

      /** The repo's worktrees: where a session's absolute paths count as the commit's files. */
      const worktrees = (repo: string) =>
        Effect.map(git(repo, ["worktree", "list", "--porcelain"]), (out) =>
          out
            .split("\n")
            .filter((l) => l.startsWith("worktree "))
            .map((l) => l.slice("worktree ".length)),
        );

      const site = Effect.fn("HistorySync.site")(
        function* (repoArg: string, range: string, out: string) {
          const repo = (yield* git(repoArg, ["rev-parse", "--show-toplevel"])).trim();
          const origin = (yield* git(repo, ["remote", "get-url", "origin"], [2])).trim();
          const web = remoteWebUrl(origin || null);
          if (!web)
            return yield* new HistoryFailed({
              message: `${repo} has no origin on a git host: the backend names repos owner/name`,
            });
          const repoName = repoKey(web);
          // One commit at a time, the subject last: a subject may hold any character.
          const shas = (yield* git(repo, [
            "rev-list",
            "--reverse",
            ...range.split(/\s+/).filter(Boolean),
          ]))
            .split("\n")
            .filter((s) => HEX.test(s));
          const commits = yield* Effect.forEach(shas, (sha) =>
            Effect.map(git(repo, ["show", "-s", `--format=%cI${US}%s`, sha]), (out) => {
              const [committedAt = "", ...rest] = out.trimEnd().split(US);
              return { sha, subject: rest.join(US), committedAt, patchId: null };
            }),
          );
          const settings = yield* backendSettings("reader").pipe(
            Effect.provideService(ServerConfig, config),
            Effect.provideService(FileSystem.FileSystem, fs),
          );
          const api = yield* connect(settings);
          const params = { ws: settings.workspace };
          const records = new Map<string, CommitRecord>();
          for (let i = 0; i < commits.length; i += LIMITS.ids) {
            const shas = commits.slice(i, i + LIMITS.ids).map((c) => c.sha);
            const found = yield* call(
              api.history.commits({ params: { ...params, repo: repoName }, payload: { shas } }),
            );
            for (const c of found.commits) records.set(c.sha, c);
          }
          const ids = [
            ...new Set([...records.values()].flatMap((c) => c.links.map((l) => l.threadId))),
          ];
          const threads = new Map<string, ThreadRecord>();
          for (let i = 0; i < ids.length; i += LIMITS.threads) {
            const found = yield* call(
              api.history.threads({
                params,
                payload: { ids: ids.slice(i, i + LIMITS.threads), repo: repoName },
              }),
            );
            for (const t of found.threads) threads.set(t.thread.id, t);
          }
          const withPaths = yield* Effect.forEach(commits, (commit) =>
            Effect.map(
              // NUL-separated: names as they are, not C-quoted (non-ASCII) or split (a newline).
              git(repo, [
                "diff-tree",
                "-z",
                "--no-commit-id",
                "--name-only",
                "-r",
                "--root",
                commit.sha,
              ]),
              (names) => ({
                commit,
                paths: names.split("\u0000").filter(Boolean),
                record: records.get(commit.sha) ?? null,
              }),
            ),
          );
          const view = publicRange(
            historyRange({
              repo,
              range,
              remoteUrl: web,
              commits: withPaths,
              threads,
              roots: yield* worktrees(repo),
              home: config.home,
            }),
            config.home,
          );
          const templateFile = path.join(config.distDir, "site", "index.html");
          const template = (yield* fs.exists(templateFile))
            ? yield* fs.readFileString(templateFile)
            : "";
          const html = ledgerSiteHtml(template, view);
          if (html === null)
            return yield* new HistoryFailed({
              message: `No page template at ${templateFile}; build it with \`vp run build\`.`,
            });
          const file = path.resolve(out, "index.html");
          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
          yield* fs.writeFileString(file, html);
          return { file, view };
        },
        Effect.catchTag("PlatformError", (e) =>
          Effect.fail(new HistoryFailed({ message: e.message })),
        ),
        Effect.provide(FetchHttpClient.layer),
      );

      const search = Effect.fn("HistorySync.search")(function* (
        repoArg: string,
        text: string,
        options: { readonly all: boolean; readonly limit: number },
      ) {
        const repo = (yield* git(repoArg, ["rev-parse", "--show-toplevel"])).trim();
        const origin = (yield* git(repo, ["remote", "get-url", "origin"], [2])).trim();
        const web = remoteWebUrl(origin || null);
        if (!options.all && !web)
          return yield* new HistoryFailed({
            message: `${repo} has no origin on a git host: pass --all to search the workspace`,
          });
        const settings = yield* backendSettings("reader").pipe(
          Effect.provideService(ServerConfig, config),
          Effect.provideService(FileSystem.FileSystem, fs),
        );
        const api = yield* connect(settings);
        return yield* call(
          api.history.search({
            params: { ws: settings.workspace },
            payload: {
              text,
              ...(options.all ? {} : { repo: repoKey(web!) }),
              limit: options.limit,
            },
          }),
        );
      }, Effect.provide(FetchHttpClient.layer));

      /** The repo's backend name (owner/name of its origin) and a client for the backend. */
      const remote = Effect.fn("HistorySync.remote")(function* (repoArg: string) {
        const repo = (yield* git(repoArg, ["rev-parse", "--show-toplevel"])).trim();
        const origin = (yield* git(repo, ["remote", "get-url", "origin"], [2])).trim();
        const web = remoteWebUrl(origin || null);
        if (!web)
          return yield* new HistoryFailed({
            message: `${repo} has no origin on a git host: the backend names repos owner/name`,
          });
        const settings = yield* backendSettings("reader").pipe(
          Effect.provideService(ServerConfig, config),
          Effect.provideService(FileSystem.FileSystem, fs),
        );
        const api = yield* connect(settings);
        return {
          api,
          params: { ws: settings.workspace, repo: repoKey(web) },
        };
      });

      const insights = Effect.fn("HistorySync.insights")(function* (
        repoArg: string,
        options: { readonly detect: boolean; readonly statuses?: ReadonlyArray<FindingStatus> },
      ) {
        const { api, params } = yield* remote(repoArg);
        const added = options.detect ? (yield* call(api.history.detect({ params }))).added : null;
        const { findings } = yield* call(
          api.history.findings({
            params,
            payload: options.statuses ? { statuses: options.statuses } : {},
          }),
        );
        return { findings, added };
      }, Effect.provide(FetchHttpClient.layer));

      const decide = Effect.fn("HistorySync.decide")(function* (
        repoArg: string,
        id: string,
        to: FindingStatus,
        why: string,
      ) {
        const { api, params } = yield* remote(repoArg);
        const { finding } = yield* call(
          api.history.transition({ params, payload: { id, to, why } }),
        );
        return finding;
      }, Effect.provide(FetchHttpClient.layer));

      const show = Effect.fn("HistorySync.show")(function* (repoArg: string, cite: string) {
        const m = /^(.+)#([^#@]+)(?:@([0-9a-f]+))?$/.exec(cite);
        if (!m)
          return yield* new HistoryFailed({
            message: `Not a citation: ${cite.slice(0, 80)} (thread#entry@version, as search prints it)`,
          });
        const { api, params } = yield* remote(repoArg);
        return yield* call(
          api.history.evidence({
            params: { ws: params.ws },
            payload: {
              threadId: m[1]!,
              entryId: m[2]!,
              ...(m[3] ? { version: m[3] } : {}),
              repo: params.repo,
            },
          }),
        );
      }, Effect.provide(FetchHttpClient.layer));

      const freezeReview = Effect.fn("HistorySync.freezeReview")(function* (
        repoArg: string,
        range: string,
        decision: {
          readonly verdict: ReviewManifest["decision"]["verdict"];
          readonly note: string;
        },
      ) {
        const { api, params } = yield* remote(repoArg);
        const top = (yield* git(repoArg, ["rev-parse", "--show-toplevel"])).trim();
        const shas = (yield* git(top, [
          "rev-list",
          "--reverse",
          ...range.split(/\s+/).filter(Boolean),
        ]))
          .split("\n")
          .filter((s) => HEX.test(s));
        const { manifest } = yield* call(
          api.history.freezeReview({ params, payload: { range, shas, ...decision } }),
        );
        return manifest;
      }, Effect.provide(FetchHttpClient.layer));

      const review = Effect.fn("HistorySync.review")(function* (repoArg: string, id: string) {
        const { api, params } = yield* remote(repoArg);
        return yield* call(api.history.review({ params, payload: { id } }));
      }, Effect.provide(FetchHttpClient.layer));

      return HistorySync.of({ sync, site, search, show, insights, decide, freezeReview, review });
    }),
  );
}
