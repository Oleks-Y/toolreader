// `toolreader history`: which agent turns wrote each commit, linked by the lines they added
// (core/history.ts), kept on the history backend (~/.toolreader/config.json).
//   toolreader history sync (--range A..B | --pr N | --sha X) [--repo PATH]
//                           [--source auto|t3|codex-app-server|codex-rollouts|claude-transcripts]
//                           [--dry-run] [--hook]
//   toolreader history status [--repo PATH] [--json] [--check]     (historyHooks.ts)
//   toolreader history push SESSION… [--repo PATH] [--source …]
//   toolreader history site (--range A..B | --pr N) [--repo PATH] [--out DIR]
//   toolreader history audit [--repo PATH] [--source …]           (core/audit.ts)
//   toolreader history login                                     (githubLogin.ts)
//   toolreader history review freeze (--range A..B | --pr N) --verdict V --note TEXT
//   toolreader history review show ID                            (core/review.ts)
//   toolreader history search TEXT [--repo PATH] [--all] [--limit N]
//   toolreader history show THREAD#ENTRY@VERSION [--repo PATH]
//   toolreader history sql QUERY                                 (backend/AgentSql.ts)
//   toolreader history media SHA256 [-o FILE]
//   toolreader history insights [--repo PATH] [--no-detect] [--status S]… [--limit N]
//   toolreader history insight propose|accept|reject|modify|implemented|monitor|evaluate ID --why TEXT
//   toolreader history insight sample --out FILE [--per-detector N]   (core/insightsEval.ts)
//   toolreader history insight score FILE [--split heldout|dev|all]
//   toolreader history turns|link|unlink …                       (declareCli.ts)
//   toolreader history skill install|uninstall [--repo PATH] [--commit]   (historySkill.ts)
//   toolreader history hook install|uninstall [--repo PATH]    (historyHooks.ts)
import * as NodeCrypto from "node:crypto";

import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag } from "effect/unstable/cli";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { auditLines, auditSessions } from "../../core/audit.ts";
import { ACTION_KINDS } from "../../core/domain.ts";
import { CHECK_KINDS, type Check } from "../../core/checks.ts";
import { redactText } from "../../core/proof.ts";
import { CliApp } from "../app.ts";
import { RepoSessions, SESSION_SOURCES } from "../RepoSessions.ts";
import { ServerConfig } from "../ServerConfig.ts";
import { declareCommands } from "./declareCli.ts";
import { BackendApi, MEDIA_TYPES, Sha256 } from "../../core/historyApi.ts";
import {
  backendSettings,
  backendTarget,
  backendUrl,
  call,
  connect,
  HistoryFailed,
} from "./HistoryClient.ts";
import { deviceLogin, saveGithubToken } from "./githubLogin.ts";
import { commitSkill, dirtyPaths, INSTALLED_PATHS, installSkill } from "./historySkill.ts";
import {
  appendLog,
  causeMessage,
  commonGitDir,
  deliveryLine,
  deliveryOf,
  installHooks,
  minute,
  pending,
} from "./historyHooks.ts";
import type { Coverage, Evidence, SearchHit } from "../../core/historyApi.ts";
import {
  FINDING_STATUSES,
  type Finding,
  type FindingStatus,
  type Submission,
} from "../../core/insights.ts";
import { evaluate, LabelRow, sampleRows } from "../../core/insightsEval.ts";
import { VERDICTS, type EvidenceNow } from "../../core/review.ts";
import { HistorySync, type SyncReport } from "./HistorySync.ts";

const PullRequest = Schema.Struct({ baseRefOid: Schema.String, headRefOid: Schema.String });
const decodePullRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(PullRequest));

/** Runs a command in `cwd`; fails with its stderr on a non-zero exit. */
const run = (cwd: string, command: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(ChildProcess.make(command, args, { cwd }));
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
        handle.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== ChildProcessSpawner.ExitCode(0))
      return yield* new HistoryFailed({
        message: `${command} ${args.join(" ")}: ${stderr.trim() || `exit ${exitCode}`}`,
      });
    return stdout;
  }).pipe(
    Effect.scoped,
    Effect.catchTag("PlatformError", (e) => Effect.fail(new HistoryFailed({ message: e.message }))),
  );

/** `--pr N`: its base..head, fetching what isn't local. */
const prRange = Effect.fn("history.prRange")(function* (repo: string, pr: number) {
  const { baseRefOid: base, headRefOid: head } = yield* run(repo, "gh", [
    "pr",
    "view",
    String(pr),
    "--json",
    "baseRefOid,headRefOid",
  ]).pipe(
    Effect.flatMap(decodePullRequest),
    Effect.mapError((e) => new HistoryFailed({ message: `PR ${pr}: ${e.message}` })),
  );
  const has = (sha: string) =>
    run(repo, "git", ["cat-file", "-e", `${sha}^{commit}`]).pipe(Effect.isSuccess);
  if (!(yield* has(head))) yield* run(repo, "git", ["fetch", "-q", "origin", `pull/${pr}/head`]);
  if (!(yield* has(base))) yield* run(repo, "git", ["fetch", "-q", "origin", base]);
  return `${base}..${head}`;
});

/** Full SHAs in a range (`a --not b c`, as the hook passes it) as `git log --oneline` shows them. */
const shortShas = (range: string) => range.replace(/\b[0-9a-f]{40}\b/g, (sha) => sha.slice(0, 8));

/** Titles are a session's first prompt line: logs (CI's included) get them redacted. */
const title = (t: string) => redactText(t).text;

/** A command as a report line shows it: chains run long. */
const short = (t: string) => (t.length > 80 ? `${t.slice(0, 79)}…` : t);

/** A link's checks: how many of each outcome, then its last test and last build, which matter most. */
const checkLines = (checks: ReadonlyArray<Check>): string[] => {
  if (checks.length === 0) return [];
  const count = (o: Check["outcome"]) => checks.filter((k) => k.outcome === o).length;
  const counts = (["passed", "failed", "interrupted", "unknown"] as const)
    .flatMap((o) => (count(o) > 0 ? [`${count(o)} ${o}`] : []))
    .join(", ");
  const last = CHECK_KINDS.flatMap((kind) => checks.findLast((k) => k.kind === kind) ?? []);
  return [
    `    checks: ${counts}`,
    ...last.flatMap((k) => [
      `    last ${k.kind}: ${k.outcome} (${k.masked ? "can't fail: || true" : k.basis}), ran on: ${k.testedState}, for this commit: ${k.applicability} · ${short(title(k.title))}`,
      `      ${k.reasons.map(title).join("; ")}`,
    ]),
  ];
};

const SKIPPED_TEXT = {
  newer: "backend has a newer copy",
  deleted: "deleted on request, not stored again",
  expired: "this version expired, not stored again",
} as const;

/** Threads the backend didn't take, and why: reported, never retried or counted as failures. */
export const skippedLines = (skipped: SyncReport["skipped"]): string[] =>
  skipped.map((k) => `! skipped ${title(k.title || k.id)} (${k.id}): ${SKIPPED_TEXT[k.why]}`);

/** What `sync` did, a line each. */
export const reportLines = (report: SyncReport, dryRun: boolean): string[] => {
  const lines: string[] = [];
  for (const { record: c, titles } of report.commits) {
    lines.push(`${c.sha.slice(0, 8)} ${c.subject}`);
    for (const l of c.links) {
      lines.push(
        l.via === "asserted"
          ? `  ✓ ${title(titles.get(l.threadId) ?? l.threadId)} (declared: ${l.turns.length} turn${l.turns.length === 1 ? "" : "s"}${l.note ? `, "${title(l.note)}"` : ""})`
          : l.via === "trailer"
            ? `  ✓ ${title(titles.get(l.threadId) ?? l.threadId)} (named by its trailer)`
            : `  ✓ ${title(titles.get(l.threadId) ?? l.threadId)} (${l.turns.length} turn${l.turns.length === 1 ? "" : "s"}, ${l.lines} line${l.lines === 1 ? "" : "s"})`,
      );
      lines.push(...checkLines(l.checks ?? []));
      if (l.reads)
        lines.push(
          `    read ${l.reads.paths.length + l.reads.more} file${l.reads.paths.length + l.reads.more === 1 ? "" : "s"} for it (as its read actions show)`,
        );
    }
    if (c.links.length === 0) lines.push("  · no explicit agent history link");
  }
  for (const why of report.ignored) lines.push(`! ignored ${title(why)}`);
  lines.push(...skippedLines(report.skipped));
  for (const u of report.unread) lines.push(`! couldn't read ${u.id} (${title(u.title)})`);
  lines.push(
    dryRun
      ? "dry run: nothing sent"
      : `${report.repo}: ${report.sent} thread${report.sent === 1 ? "" : "s"} sent, ${report.unchanged} unchanged, ${report.commits.length} commit${report.commits.length === 1 ? "" : "s"} linked`,
  );
  return lines;
};

const sync = Command.make(
  "sync",
  {
    repo: Flag.string("repo").pipe(
      Flag.withDescription("Repository (any path inside it)"),
      Flag.withDefault("."),
    ),
    range: Flag.string("range").pipe(
      Flag.withDescription("Commits, as `git log` takes them: main..HEAD"),
      Flag.optional,
    ),
    pr: Flag.integer("pr").pipe(
      Flag.withDescription("A GitHub pull request's commits (base..head, through `gh`)"),
      Flag.optional,
    ),
    sha: Flag.string("sha").pipe(Flag.withDescription("One commit"), Flag.optional),
    source: Flag.choice("source", SESSION_SOURCES).pipe(
      Flag.withDescription(
        "Where sessions come from. auto: T3 if its database exists, plus Codex rollout files and Claude Code transcripts",
      ),
      Flag.withDefault("auto"),
    ),
    dryRun: Flag.boolean("dry-run").pipe(
      Flag.withDescription("Link and report, but send nothing to the backend"),
    ),
    hook: Flag.boolean("hook").pipe(
      Flag.withDescription(
        "Run as a git hook: report to ~/.toolreader/history.log, never fail, and retry what failed before",
      ),
    ),
  },
  Effect.fn("toolreader history sync")(function* (flags) {
    const repo = (yield* Path.Path).resolve(flags.repo);
    const given = [
      Option.isSome(flags.range),
      Option.isSome(flags.pr),
      Option.isSome(flags.sha),
    ].filter(Boolean).length;
    if (given !== 1)
      return yield* new HistoryFailed({
        message: "Give exactly one of --range A..B, --pr N or --sha X",
      });
    const range = Option.isSome(flags.range)
      ? flags.range.value
      : Option.isSome(flags.pr)
        ? yield* prRange(repo, flags.pr.value)
        : `-1 ${Option.getOrThrow(flags.sha)}`;
    const app = CliApp({ appServer: flags.source === "codex-app-server", codexHome: null });
    const syncRange = (r: string) =>
      Effect.flatMap(HistorySync, (h) =>
        h.sync(repo, r, { source: flags.source, dryRun: flags.dryRun }),
      ).pipe(Effect.provide(app));
    if (!flags.hook) {
      for (const line of reportLines(yield* syncRange(range), flags.dryRun))
        yield* Console.log(line);
      return;
    }
    // As a hook: what failed before in this repo first, then this push; whatever fails waits.
    yield* Effect.gen(function* () {
      // Keyed by the repository (its common git dir), so any of its worktrees retries.
      const store = yield* pending(yield* commonGitDir(repo));
      const lines: string[] = [];
      for (const r of new Set([...(yield* store.list).map((p) => p.range), range])) {
        const done = yield* Effect.result(syncRange(r));
        if (done._tag === "Success") {
          lines.push(...reportLines(done.success, false));
          yield* store.done(r);
        } else {
          yield* store.failed(
            r,
            done.failure._tag === "HistoryFailed" ? (done.failure.code ?? "FAILED") : "FAILED",
          );
          lines.push(
            `✗ ${shortShas(r)}: ${redactText(done.failure.message).text} (retried by the next push)`,
          );
        }
      }
      yield* appendLog(`sync ${shortShas(range)} in ${repo}`, lines);
    }).pipe(
      // Crashes too: a detached job has nowhere else to say it died.
      Effect.catchCause((cause) =>
        appendLog(`sync ${shortShas(range)} in ${repo}`, [`✗ ${causeMessage(cause)}`]),
      ),
      Effect.provide(ServerConfig.layer),
      Effect.ignore,
    );
  }),
).pipe(
  Command.withDescription(
    "Sync a range's explicit agent declarations and session trailers to the backend",
  ),
);

const StatusJson = Schema.Struct({
  backend: Schema.Struct({
    url: Schema.NullOr(Schema.String),
    workspace: Schema.NullOr(Schema.String),
    hasToken: Schema.Boolean,
  }),
  delivery: Schema.Struct({
    pending: Schema.Number,
    firstFailureAt: Schema.NullOr(Schema.String),
    lastAttemptAt: Schema.NullOr(Schema.String),
    lastErrorCode: Schema.NullOr(Schema.String),
    ranges: Schema.Array(
      Schema.Struct({
        range: Schema.String,
        firstFailureAt: Schema.NullOr(Schema.String),
        lastAttemptAt: Schema.NullOr(Schema.String),
        lastErrorCode: Schema.NullOr(Schema.String),
      }),
    ),
  }),
  check: Schema.optional(
    Schema.Struct({
      ok: Schema.Boolean,
      server: Schema.optional(Schema.String),
      errorCode: Schema.optional(Schema.String),
    }),
  ),
});
export type StatusJson = typeof StatusJson.Type;
const encodeStatus = Schema.encodeSync(Schema.fromJsonString(StatusJson, { space: 2 }));

/** `history status`, as plain lines. */
export const statusLines = (s: StatusJson): string[] => [
  s.backend.url
    ? `Backend: ${s.backend.url}${s.backend.workspace ? ` (workspace ${s.backend.workspace})` : " (no workspace set)"}${s.backend.hasToken ? "" : ", no token"}`
    : "Backend: not configured",
  deliveryLine(s.delivery),
  ...s.delivery.ranges.map(
    (r) =>
      `  ${shortShas(r.range)}: first failure ${minute(r.firstFailureAt)}, last attempt ${minute(r.lastAttemptAt)}, last error ${r.lastErrorCode ?? "unknown"}`,
  ),
  ...(s.check
    ? [
        s.check.ok
          ? `Check: ok (backend ${s.check.server ?? "?"} took this token)`
          : `Check: failed (${s.check.errorCode ?? "FAILED"})`,
      ]
    : []),
];

/** What `history status` reports: pending ranges for this repo, the backend, and with `check` a signed-in call. */
export const deliveryStatus = Effect.fn("history.status")(function* (repo: string, check: boolean) {
  const ranges = yield* Effect.flatMap(Effect.flatMap(commonGitDir(repo), pending), (s) => s.list);
  const target = yield* backendTarget.pipe(
    Effect.orElseSucceed(() => ({ file: "", url: null, workspace: null, hasToken: false })),
  );
  const checked = check
    ? yield* Effect.flatMap(backendSettings(), (settings) =>
        Effect.flatMap(connect(settings), (api) => call(api.system.meta())),
      ).pipe(
        Effect.match({
          onSuccess: (meta): NonNullable<StatusJson["check"]> => ({
            ok: true,
            server: meta.server,
          }),
          onFailure: (e): NonNullable<StatusJson["check"]> => ({
            ok: false,
            errorCode: e.code ?? "FAILED",
          }),
        }),
        Effect.provide(FetchHttpClient.layer),
      )
    : undefined;
  return {
    backend: { url: target.url, workspace: target.workspace, hasToken: target.hasToken },
    delivery: {
      ...deliveryOf(ranges),
      ranges: ranges.map((r) => ({
        range: r.range,
        firstFailureAt: r.firstFailureAt ?? null,
        lastAttemptAt: r.lastAttemptAt ?? null,
        lastErrorCode: r.lastErrorCode ?? null,
      })),
    },
    ...(checked ? { check: checked } : {}),
  } satisfies StatusJson;
});

const status = Command.make(
  "status",
  {
    repo: Flag.string("repo").pipe(
      Flag.withDescription("Repository (any path inside it)"),
      Flag.withDefault("."),
    ),
    json: Flag.boolean("json").pipe(Flag.withDescription("Print it as JSON")),
    check: Flag.boolean("check").pipe(
      Flag.withDescription("Also ask the backend whether it takes this machine's token"),
    ),
  },
  Effect.fn("toolreader history status")(function* (flags) {
    const repo = (yield* Path.Path).resolve(flags.repo);
    const s = yield* deliveryStatus(repo, flags.check);
    if (flags.json) yield* Console.log(encodeStatus(s));
    else for (const line of statusLines(s)) yield* Console.log(line);
    if (s.check && !s.check.ok)
      return yield* new HistoryFailed({
        message: `The backend check failed (${s.check.errorCode})`,
        code: s.check.errorCode,
      });
  }, Effect.provide(ServerConfig.layer)),
).pipe(
  Command.withDescription(
    "Show what history delivery is waiting on in this repo (ranges a hook couldn't send), and where it goes; retries nothing",
  ),
);

const push = Command.make(
  "push",
  {
    sessions: Argument.string("session").pipe(
      Argument.withDescription(
        "A thread id, codex:<id> or claude:<id>; its subagents go with it (repeatable)",
      ),
      Argument.atLeast(1),
    ),
    repo: Flag.string("repo").pipe(
      Flag.withDescription("Repository (any path inside it) the sessions worked in"),
      Flag.withDefault("."),
    ),
    source: Flag.choice("source", SESSION_SOURCES).pipe(
      Flag.withDescription("Where sessions come from, as for sync"),
      Flag.withDefault("auto"),
    ),
  },
  Effect.fn("toolreader history push")(function* (flags) {
    const repo = (yield* Path.Path).resolve(flags.repo);
    const report = yield* Effect.flatMap(HistorySync, (h) =>
      h.push(repo, flags.sessions, flags.source),
    ).pipe(Effect.provide(CliApp({ appServer: false, codexHome: null })));
    for (const t of report.threads)
      yield* Console.log(
        `${t.id}${t.parent ? ` (subagent of ${t.parent})` : ""} · ${short(title(t.title))}`,
      );
    for (const line of skippedLines(report.skipped)) yield* Console.log(line);
    yield* Console.log(
      `${report.sent} sent, ${report.unchanged} unchanged${report.images ? `; ${report.imagesSent} of ${report.images} images sent` : ""}`,
    );
  }),
).pipe(
  Command.withDescription(
    "Send sessions whole, with their subagents, so agents elsewhere can read them by id (redacted, as sync sends them)",
  ),
);

const site = Command.make(
  "site",
  {
    repo: Flag.string("repo").pipe(
      Flag.withDescription("Repository (any path inside it)"),
      Flag.withDefault("."),
    ),
    range: Flag.string("range").pipe(
      Flag.withDescription("Commits, as `git log` takes them: main..HEAD"),
      Flag.optional,
    ),
    pr: Flag.integer("pr").pipe(
      Flag.withDescription("A GitHub pull request's commits (base..head, through `gh`)"),
      Flag.optional,
    ),
    out: Flag.string("out").pipe(
      Flag.withDescription("Directory to write index.html into"),
      Flag.withDefault("history-site"),
    ),
  },
  Effect.fn("toolreader history site")(function* (flags) {
    const repo = (yield* Path.Path).resolve(flags.repo);
    if (Option.isSome(flags.range) === Option.isSome(flags.pr))
      return yield* new HistoryFailed({ message: "Give exactly one of --range A..B or --pr N" });
    const range = Option.isSome(flags.range)
      ? flags.range.value
      : yield* prRange(repo, Option.getOrThrow(flags.pr));
    const { file, view } = yield* Effect.flatMap(HistorySync, (h) =>
      h.site(repo, range, flags.out),
    ).pipe(Effect.provide(CliApp({ appServer: false, codexHome: null })));
    const linked = view.commits.filter((c) => (c.entry?.links.length ?? 0) > 0).length;
    yield* Console.log(
      `${file}\n${view.repo}: ${view.commits.length} commits, ${linked} with agent history`,
    );
  }),
).pipe(
  Command.withDescription(
    "Write a self-contained page of a range's agent history, as the backend has it (opens from file:// or any static host)",
  ),
);

/** A search hit, as `history search` prints it: when and what, its session, the match, a citation. */
export const hitLines = (hit: SearchHit): string[] => [
  `${hit.at.slice(0, 16).replace("T", " ")} · ${hit.kind}${hit.status ? ` ${hit.status}` : ""} · ${short(title(hit.title || "(untitled)"))}`,
  `  in ${short(title(hit.threadTitle || hit.threadId))}`,
  ...(hit.snippet ? [`  ${title(hit.snippet)}`] : []),
  `  cite ${hit.threadId}#${hit.entryId}@${hit.version.slice(0, 12)}`,
];

const search = Command.make(
  "search",
  {
    text: Argument.string("text").pipe(
      Argument.withDescription(
        "What to find, in any case: an error, a command, a path; leave it out to list the newest entries the other filters keep",
      ),
      Argument.optional,
    ),
    repo: Flag.string("repo").pipe(
      Flag.withDescription("Repository (any path inside it): searches its sessions"),
      Flag.withDefault("."),
    ),
    all: Flag.boolean("all").pipe(
      Flag.withDescription("Search every session in the workspace, not only this repo's"),
    ),
    commit: Flag.string("commit").pipe(
      Flag.withDescription("Only sessions linked to this commit (any revision, or a SHA prefix)"),
      Flag.optional,
    ),
    kind: Flag.choice("kind", ACTION_KINDS).pipe(
      Flag.withDescription("Only actions of this kind (repeatable): read, edit, test, build…"),
      Flag.atLeast(0),
    ),
    limit: Flag.integer("limit").pipe(Flag.withDescription("Hits to show"), Flag.withDefault(20)),
  },
  Effect.fn("toolreader history search")(function* (flags) {
    const repo = (yield* Path.Path).resolve(flags.repo);
    const text = Option.getOrUndefined(flags.text)?.trim();
    if (text !== undefined && text.length < 2)
      return yield* new HistoryFailed({ message: "Search for at least 2 characters" });
    const { hits, truncated } = yield* Effect.flatMap(HistorySync, (h) =>
      h.search(repo, text, {
        all: flags.all,
        limit: flags.limit,
        commit: Option.getOrUndefined(flags.commit),
        kinds: flags.kind,
      }),
    ).pipe(Effect.provide(CliApp({ appServer: false, codexHome: null })));
    for (const hit of hits) for (const line of hitLines(hit)) yield* Console.log(line);
    yield* Console.log(
      hits.length === 0
        ? "nothing found"
        : `${hits.length} hit${hits.length === 1 ? "" : "s"}${truncated ? ", more not shown (--limit)" : ""}`,
    );
  }),
).pipe(
  Command.withDescription(
    "Find sessions' commands, errors, outputs, messages and paths on the backend, newest first, each with a citation",
  ),
);

/** A SQL result's coverage, as `history sql` prints it to stderr. */
export const coverageLines = (c: Coverage): string[] => [
  `as of ${c.asOf}: ${c.threads} conversation${c.threads === 1 ? "" : "s"} in the workspace, ${c.behind} may be behind their live session`,
  ...c.mayBeBehind.map(
    (t) =>
      `  ${t.id} · ${t.state} · last entry ${t.lastEntryAt ?? "unknown"} · checked ${t.checkedAt ?? "never"} · ${short(title(t.title))}`,
  ),
  ...(c.behind > c.mayBeBehind.length ? [`  … and ${c.behind - c.mayBeBehind.length} more`] : []),
];

const encodeSqlRow = Schema.encodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

// What agents read the workspace's conversations with: one JSON object per row on stdout, the
// count on stderr, so the rows pipe straight into jq.
const sql = Command.make(
  "sql",
  {
    query: Argument.string("query").pipe(
      Argument.withDescription(
        "Read-only SQL over agent_threads (id, title, source, provider, parent, taken_at, version, entry_count, last_entry_at, source_state, checked_at) and agent_entries (thread_id, seq, turn, entry_id, at, type, kind, status, title, hint, command, exit_code, output, text, files)",
      ),
    ),
  },
  Effect.fn("toolreader history sql")(
    function* ({ query }) {
      const settings = yield* backendSettings("reader");
      const api = yield* connect(settings);
      const { rows, truncated, coverage } = yield* call(
        api.history.sql({ params: { ws: settings.workspace }, payload: { query } }),
      );
      for (const row of rows) yield* Console.log(encodeSqlRow(row));
      yield* Console.error(
        `${rows.length} row${rows.length === 1 ? "" : "s"}${truncated ? ", more not shown: add a LIMIT or select fewer columns" : ""}`,
      );
      if (coverage) for (const line of coverageLines(coverage)) yield* Console.error(line);
    },
    Effect.provide([FetchHttpClient.layer, ServerConfig.layer]),
  ),
).pipe(
  Command.withDescription(
    "Query every conversation in the workspace with read-only SQL, whoever's machine it came from",
  ),
);

const decodeSha256 = Schema.decodeUnknownEffect(Sha256);
// The backend's mime names the file's extension, so only the types it keeps get through.
const decodeMediaType = Schema.decodeUnknownEffect(Schema.Literals(MEDIA_TYPES));

/**
 * One stored image written to `out` (default `<sha256>.<ext>` here), its bytes checked against
 * the hash first: what `history media` hands a person.
 */
export const saveMedia = Effect.fn("toolreader history media.save")(function* (
  sha: string,
  out: string | undefined,
) {
  const sha256 = yield* decodeSha256(sha).pipe(
    Effect.mapError(() => new HistoryFailed({ message: `${sha}: a SHA-256 is 64 hex characters` })),
  );
  const settings = yield* backendSettings("reader");
  const api = yield* connect(settings);
  const image = yield* call(
    api.history.media({ params: { ws: settings.workspace }, payload: { sha256 } }),
  );
  const mime = yield* decodeMediaType(image.mime).pipe(
    Effect.mapError(() => new HistoryFailed({ message: `Not an image type: ${image.mime}` })),
  );
  const bytes = Buffer.from(image.data, "base64");
  if (NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== sha256)
    return yield* new HistoryFailed({ message: `The backend's bytes don't hash to ${sha256}` });
  const path = (yield* Path.Path).resolve(out ?? `${sha256}.${mime.slice("image/".length)}`);
  yield* (yield* FileSystem.FileSystem)
    .writeFile(path, bytes)
    .pipe(Effect.mapError((e) => new HistoryFailed({ message: e.message })));
  return { path, mime, bytes: bytes.length };
});

const media = Command.make(
  "media",
  {
    sha256: Argument.string("sha256").pipe(
      Argument.withDescription("The image's SHA-256, as agent_entries.media lists it"),
    ),
    out: Flag.string("out").pipe(
      Flag.withAlias("o"),
      Flag.withDescription("Where to write it (default: <sha256>.<ext> here)"),
      Flag.optional,
    ),
  },
  Effect.fn("toolreader history media")(
    function* ({ sha256, out }) {
      const saved = yield* saveMedia(sha256, Option.getOrUndefined(out));
      yield* Console.log(saved.path);
      yield* Console.error(`${saved.mime}, ${saved.bytes} bytes`);
    },
    Effect.provide([FetchHttpClient.layer, ServerConfig.layer]),
  ),
).pipe(
  Command.withDescription(
    "Write a screenshot an agent looked at to a file, by its SHA-256, to hand it to a person",
  ),
);

/** Statuses still open to a decision or follow-up: what `insights` lists by default. */
const OPEN: ReadonlyArray<FindingStatus> = [
  "detected",
  "proposed",
  "accepted",
  "modified",
  "implemented",
  "monitoring",
];

/** A finding, as `history insights` prints it. */
export const findingLines = (f: Finding): string[] => [
  `${f.id} · ${f.status} · ${f.detector} · ${f.sessions} sessions`,
  `  ${short(title(f.subject))}`,
  `  ${title(f.pattern)}`,
  `  next: ${title(f.suggestion)}`,
  ...f.occurrences
    .slice(0, 3)
    .map(
      (o) =>
        `  cite ${o.threadId}#${o.entryId}${o.version ? `@${o.version.slice(0, 12)}` : ""}${o.quote ? ` :: ${short(title(o.quote))}` : ""}`,
    ),
  ...(f.occurrences.length > 3 ? [`  … and ${f.occurrences.length - 3} more`] : []),
  ...(f.events.length > 0
    ? [
        `  last: ${f.events.at(-1)!.from} → ${f.events.at(-1)!.to} by ${f.events.at(-1)!.by}: ${title(f.events.at(-1)!.why)}`,
      ]
    : []),
];

/** What a citation reads now, as `history show` prints it. */
export const evidenceLines = (cite: string, e: Evidence): string[] => {
  if (e.status !== "ok" || !e.entry)
    return [
      `${cite}: ${
        {
          ok: "no such entry",
          "version-unavailable": `replaced since; now ${e.version?.slice(0, 12) ?? "?"} (read it with that version to see what it says now)`,
          withheld: "withheld: not yours to read from this repo",
          deleted: "deleted on request",
          expired: "expired: past the retention period",
          missing: "not on the backend",
        }[e.status]
      }`,
    ];
  const x = e.entry;
  if (x.type === "message")
    return [`${x.at.slice(0, 16).replace("T", " ")} · ${x.role}`, title(x.text)];
  return x.type !== "action"
    ? [`${x.at.slice(0, 16).replace("T", " ")} · ${x.type}`]
    : [
        `${x.at.slice(0, 16).replace("T", " ")} · ${x.kind} ${x.status}${x.exitCode === undefined ? "" : ` (exit ${x.exitCode})`} · ${title(x.title)}`,
        ...(x.command ? [`$ ${title(x.command)}`] : []),
        ...(x.output ? [title(x.output)] : []),
        ...(x.files ?? []).map((f) => `  ${f.path} +${f.added} -${f.removed}`),
      ];
};

const show = Command.make(
  "show",
  {
    cite: Argument.string("citation").pipe(
      Argument.withDescription("thread#entry@version, as search and insights print it"),
    ),
    repo: Flag.string("repo").pipe(
      Flag.withDescription("Repository (any path inside it)"),
      Flag.withDefault("."),
    ),
  },
  Effect.fn("toolreader history show")(function* (flags) {
    const repo = (yield* Path.Path).resolve(flags.repo);
    const evidence = yield* Effect.flatMap(HistorySync, (h) => h.show(repo, flags.cite)).pipe(
      Effect.provide(CliApp({ appServer: false, codexHome: null })),
    );
    for (const line of evidenceLines(flags.cite, evidence)) yield* Console.log(line);
  }),
).pipe(
  Command.withDescription(
    "Read a citation back: the entry as that version holds it, or why it can't be read (replaced, withheld, deleted, expired)",
  ),
);

const insights = Command.make(
  "insights",
  {
    repo: Flag.string("repo").pipe(
      Flag.withDescription("Repository (any path inside it)"),
      Flag.withDefault("."),
    ),
    noDetect: Flag.boolean("no-detect").pipe(
      Flag.withDescription("List what's stored without running the detectors first"),
    ),
    status: Flag.choice("status", FINDING_STATUSES).pipe(
      Flag.withDescription("Only findings in this status (repeatable); default: the open ones"),
      Flag.atLeast(0),
    ),
    limit: Flag.integer("limit").pipe(
      Flag.withDescription("Findings to show, most sessions first"),
      Flag.withDefault(10),
    ),
  },
  Effect.fn("toolreader history insights")(function* (flags) {
    const repo = (yield* Path.Path).resolve(flags.repo);
    const statuses = flags.status.length > 0 ? flags.status : OPEN;
    const { findings, added } = yield* Effect.flatMap(HistorySync, (h) =>
      h.insights(repo, { detect: !flags.noDetect, statuses }),
    ).pipe(Effect.provide(CliApp({ appServer: false, codexHome: null })));
    for (const f of findings.slice(0, flags.limit))
      for (const line of findingLines(f)) yield* Console.log(line);
    yield* Console.log(
      `${findings.length} finding${findings.length === 1 ? "" : "s"} (${statuses.join(", ")})${findings.length > flags.limit ? `, ${flags.limit} shown` : ""}${added === null ? "" : `; ${added} new this run`}`,
    );
  }),
).pipe(
  Command.withDescription(
    "Run Project Insights over this repo's history on the backend (recurring failures, repeated investigations) and list the findings",
  ),
);

/** Each lifecycle step as a command, and the status it moves a finding to. */
const DECISIONS = {
  propose: "proposed",
  accept: "accepted",
  reject: "rejected",
  modify: "modified",
  implemented: "implemented",
  monitor: "monitoring",
  evaluate: "evaluated",
} as const satisfies Record<string, FindingStatus>;

// What an agent runs after its own investigation (history search, history show): the pattern it
// found, what a person could do about it, and the entries that show it.
const submit = Command.make(
  "submit",
  {
    subject: Flag.string("subject").pipe(
      Flag.withDescription(
        "What it's about, in a few words (a file, an error, a step); the same subject again updates it",
      ),
    ),
    pattern: Flag.string("pattern").pipe(
      Flag.withDescription("What the sessions show, in a sentence or two"),
    ),
    suggestion: Flag.string("suggestion").pipe(
      Flag.withDescription("A step a person could take: a suggestion, not a diagnosis"),
    ),
    cite: Flag.string("cite").pipe(
      Flag.withDescription(
        'An entry that shows it and the words in it that do: "THREAD#ENTRY@VERSION :: quoted text" (the citation as search prints it, then the text copied from that entry; repeatable, at least one)',
      ),
      Flag.atLeast(1),
    ),
    repo: Flag.string("repo").pipe(
      Flag.withDescription("Repository (any path inside it)"),
      Flag.withDefault("."),
    ),
  },
  Effect.fn("toolreader history insight submit")(function* (flags) {
    const repo = (yield* Path.Path).resolve(flags.repo);
    const citations: Array<Submission["citations"][number]> = [];
    for (const c of flags.cite) {
      const at = c.indexOf(" :: ");
      const quote = at === -1 ? "" : c.slice(at + 4).trim();
      const m = /^(.+)#([^#@]+)(?:@([0-9a-f]+))?$/.exec((at === -1 ? c : c.slice(0, at)).trim());
      if (!m || quote.length < 3)
        return yield* new HistoryFailed({
          message: `Not a quoted citation: ${c.slice(0, 80)} (want "THREAD#ENTRY@VERSION :: text from that entry", at least 3 characters of it)`,
        });
      citations.push({
        threadId: m[1]!,
        entryId: m[2]!,
        ...(m[3] ? { version: m[3] } : {}),
        quote,
      });
    }
    const { finding, added } = yield* Effect.flatMap(HistorySync, (h) =>
      h.submit(repo, {
        subject: flags.subject,
        pattern: flags.pattern,
        suggestion: flags.suggestion,
        citations,
      }),
    ).pipe(Effect.provide(CliApp({ appServer: false, codexHome: null })));
    yield* Console.log(added ? "submitted a new finding" : "updated the finding's evidence");
    for (const line of findingLines(finding)) yield* Console.log(line);
    yield* Console.log(
      `  next: a person proposes or rejects it (history insight propose|reject ${finding.id} --why …)`,
    );
  }),
).pipe(
  Command.withDescription(
    "Submit a finding from your own investigation, each claim cited; it waits as detected for a person",
  ),
);

const members = Command.make(
  "members",
  {
    id: Argument.string("id").pipe(Argument.withDescription("The finding, as insights lists it")),
    add: Flag.string("add").pipe(
      Flag.withDescription("A session to add (repeatable)"),
      Flag.atLeast(0),
    ),
    remove: Flag.string("remove").pipe(
      Flag.withDescription("A session to remove (repeatable)"),
      Flag.atLeast(0),
    ),
    why: Flag.string("why").pipe(Flag.withDescription("Why: kept with the finding")),
    repo: Flag.string("repo").pipe(
      Flag.withDescription("Repository (any path inside it)"),
      Flag.withDefault("."),
    ),
  },
  Effect.fn("toolreader history insight members")(function* (flags) {
    const repo = (yield* Path.Path).resolve(flags.repo);
    const finding = yield* Effect.flatMap(HistorySync, (h) =>
      h.correct(repo, flags.id, { add: flags.add, remove: flags.remove, why: flags.why }),
    ).pipe(Effect.provide(CliApp({ appServer: false, codexHome: null })));
    for (const line of findingLines(finding)) yield* Console.log(line);
  }),
).pipe(
  Command.withDescription(
    "Correct a finding's members: sessions that belong in its group, or don't",
  ),
);

const decision = (action: keyof typeof DECISIONS) =>
  Command.make(
    action,
    {
      id: Argument.string("id").pipe(Argument.withDescription("The finding, as insights lists it")),
      why: Flag.string("why").pipe(Flag.withDescription("Why: kept with the finding")),
      repo: Flag.string("repo").pipe(
        Flag.withDescription("Repository (any path inside it)"),
        Flag.withDefault("."),
      ),
    },
    Effect.fn(`toolreader history insight ${action}`)(function* (flags) {
      const repo = (yield* Path.Path).resolve(flags.repo);
      const finding = yield* Effect.flatMap(HistorySync, (h) =>
        h.decide(repo, flags.id, DECISIONS[action], flags.why),
      ).pipe(Effect.provide(CliApp({ appServer: false, codexHome: null })));
      for (const line of findingLines(finding)) yield* Console.log(line);
    }),
  ).pipe(Command.withDescription(`Mark a finding ${DECISIONS[action]}, with why`));

const login = Command.make(
  "login",
  {},
  Effect.fn("toolreader history login")(
    function* () {
      const url = yield* backendUrl();
      const api = yield* HttpApiClient.make(BackendApi, { baseUrl: url });
      const { github } = yield* call(api.system.signIn());
      if (!github)
        return yield* new HistoryFailed({
          message: `${url} has no GitHub sign-in: ask whoever runs it for a workspace token`,
        });
      const token = yield* deviceLogin(github.webUrl, github.clientId, (uri, code) =>
        Console.log(`Open ${uri} and enter ${code}`),
      );
      const { userConfigPath } = yield* ServerConfig;
      yield* saveGithubToken(userConfigPath, token);
      yield* Console.log(
        `Signed in. Searches, pages and decisions now go as your GitHub account (${userConfigPath}).`,
      );
    },
    Effect.provide([FetchHttpClient.layer, ServerConfig.layer]),
  ),
).pipe(
  Command.withDescription(
    "Sign in with GitHub: read this repo's history and decide on findings as yourself",
  ),
);

const encodeRow = Schema.encodeSync(Schema.fromJsonString(LabelRow));
const decodeRow = Schema.decodeUnknownEffect(Schema.fromJsonString(LabelRow));

const sample = Command.make(
  "sample",
  {
    out: Flag.string("out").pipe(Flag.withDescription("The JSONL file to write, for labelling")),
    perDetector: Flag.integer("per-detector").pipe(
      Flag.withDescription("Findings per detector, most sessions first"),
      Flag.withDefault(30),
    ),
    repo: Flag.string("repo").pipe(
      Flag.withDescription("Repository (any path inside it)"),
      Flag.withDefault("."),
    ),
  },
  Effect.fn("toolreader history insight sample")(function* (flags) {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const repo = path.resolve(flags.repo);
    const { findings } = yield* Effect.flatMap(HistorySync, (h) =>
      h.insights(repo, { detect: false }),
    ).pipe(Effect.provide(CliApp({ appServer: false, codexHome: null })));
    const rows = sampleRows(findings, flags.perDetector);
    yield* fs.writeFileString(
      path.resolve(flags.out),
      rows.map((r) => `${encodeRow(r)}\n`).join(""),
    );
    const held = rows.filter((r) => r.split === "heldout").length;
    yield* Console.log(
      `${rows.length} rows in ${flags.out} (${held} held out). Set each "label" to real, known or noise; add what the detectors missed as rows with "missed": true; a second labeller fills "label2".`,
    );
  }),
).pipe(
  Command.withDescription("Write findings to a file to label, each on a fixed side of the split"),
);

const pct = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`);

const score = Command.make(
  "score",
  {
    file: Argument.string("file").pipe(Argument.withDescription("The labelled JSONL file")),
    split: Flag.choice("split", ["heldout", "dev", "all"] as const).pipe(
      Flag.withDescription("Which rows to score: tune on dev, report on heldout"),
      Flag.withDefault("heldout"),
    ),
  },
  Effect.fn("toolreader history insight score")(function* ({ file, split }) {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(file);
    const rows = yield* Effect.forEach(
      text.split("\n").filter((l) => l.trim()),
      (line, i) =>
        decodeRow(line).pipe(
          Effect.mapError(
            () => new HistoryFailed({ message: `${file}:${i + 1} isn't a label row` }),
          ),
        ),
    );
    for (const s of evaluate(rows, split))
      yield* Console.log(
        `${s.detector}: ${s.labelled} labelled · precision ${pct(s.precision)} · new to the reader ${pct(s.novel)} · recall ${pct(s.recall)} · agreement ${pct(s.agreement)} of ${s.doubleLabelled}`,
      );
  }),
).pipe(
  Command.withDescription(
    "Score labelled findings per detector: precision, novelty, recall, agreement",
  ),
);

const freeze = Command.make(
  "freeze",
  {
    repo: Flag.string("repo").pipe(
      Flag.withDescription("Repository (any path inside it)"),
      Flag.withDefault("."),
    ),
    range: Flag.string("range").pipe(Flag.withDescription("Commits: main..HEAD"), Flag.optional),
    pr: Flag.integer("pr").pipe(
      Flag.withDescription("A GitHub pull request's commits"),
      Flag.optional,
    ),
    verdict: Flag.choice("verdict", VERDICTS).pipe(Flag.withDescription("The decision")),
    note: Flag.string("note").pipe(Flag.withDescription("Why"), Flag.withDefault("")),
  },
  Effect.fn("toolreader history review freeze")(function* (flags) {
    const repo = (yield* Path.Path).resolve(flags.repo);
    if (Option.isSome(flags.range) === Option.isSome(flags.pr))
      return yield* new HistoryFailed({ message: "Give exactly one of --range A..B or --pr N" });
    const range = Option.isSome(flags.range)
      ? flags.range.value
      : yield* prRange(repo, Option.getOrThrow(flags.pr));
    const m = yield* Effect.flatMap(HistorySync, (h) =>
      h.freezeReview(repo, range, { verdict: flags.verdict, note: flags.note }),
    ).pipe(Effect.provide(CliApp({ appServer: false, codexHome: null })));
    yield* Console.log(
      `review ${m.id}: ${m.decision.verdict} by ${m.by}, ${m.commits.filter((c) => c.links.length > 0).length} of ${m.shas.length} commits with agent history, ${m.evidence.length} sessions cited at their versions, ${m.findings.length} findings as they stood`,
    );
  }),
).pipe(
  Command.withDescription(
    "Freeze a review: what it was shown, at the versions shown, and the decision",
  ),
);

const NOW_TEXT: Record<EvidenceNow, string> = {
  same: "as reviewed",
  replaced: "replaced since",
  deleted: "deleted on request: its conclusions were taken out",
  expired: "expired: its conclusions were taken out",
  missing: "not on the backend",
};

const reopen = Command.make(
  "show",
  {
    id: Argument.string("id").pipe(Argument.withDescription("The review, as freeze printed it")),
    repo: Flag.string("repo").pipe(
      Flag.withDescription("Repository (any path inside it)"),
      Flag.withDefault("."),
    ),
  },
  Effect.fn("toolreader history review show")(function* (flags) {
    const repo = (yield* Path.Path).resolve(flags.repo);
    const { manifest: m, now } = yield* Effect.flatMap(HistorySync, (h) =>
      h.review(repo, flags.id),
    ).pipe(Effect.provide(CliApp({ appServer: false, codexHome: null })));
    yield* Console.log(
      `review ${m.id} of ${m.repo} ${shortShas(m.range)}: ${m.decision.verdict} by ${m.by} at ${m.createdAt}${m.decision.note ? `, "${title(m.decision.note)}"` : ""}`,
    );
    yield* Console.log(
      `  methods: ${m.methods.checks}, detectors ${m.methods.detectors}, backend ${m.methods.server}`,
    );
    for (const line of reportLines(
      {
        repo: m.repo,
        commits: m.commits.map((record) => ({ record, titles: new Map() })),
        sent: 0,
        unchanged: 0,
        skipped: [],
        ignored: [],
        unread: [],
      },
      true,
    ).slice(0, -1))
      yield* Console.log(`  ${line}`);
    for (const e of now) yield* Console.log(`  cited ${e.threadId}: ${NOW_TEXT[e.status]}`);
    const open = m.findings.filter(
      (f) => f.status !== "rejected" && f.status !== "evaluated",
    ).length;
    yield* Console.log(`  findings then: ${m.findings.length} (${open} open)`);
  }),
).pipe(
  Command.withDescription(
    "Reopen a frozen review exactly as it was, and say what each cited session is now",
  ),
);

const audit = Command.make(
  "audit",
  {
    repo: Flag.string("repo").pipe(
      Flag.withDescription("Repository (any path inside it)"),
      Flag.withDefault("."),
    ),
    source: Flag.choice("source", SESSION_SOURCES).pipe(
      Flag.withDescription("Where sessions come from, as for sync"),
      Flag.withDefault("auto"),
    ),
  },
  Effect.fn("toolreader history audit")(function* (flags) {
    const repo = (yield* Path.Path).resolve(flags.repo);
    const loaded = yield* Effect.flatMap(RepoSessions, (r) => r.load(repo, flags.source)).pipe(
      Effect.mapError((e) => new HistoryFailed({ message: e.message })),
      Effect.provide(CliApp({ appServer: flags.source === "codex-app-server", codexHome: null })),
    );
    const audit = auditSessions(
      loaded.sessions.map((s) => ({
        provider: s.thread.provider ?? s.thread.source,
        subagent: s.thread.parent !== null,
        entries: s.entries,
        snapshot: s.snapshot,
      })),
    );
    for (const line of auditLines(audit, loaded.unread.length)) yield* Console.log(line);
  }),
).pipe(
  Command.withDescription(
    "Count what this repo's sessions recorded (starting state, exit codes, exact edits), without printing any of it",
  ),
);

const installer = (action: "install" | "uninstall") =>
  Command.make(
    action,
    {
      repo: Flag.string("repo").pipe(
        Flag.withDescription("Repository (any path inside it)"),
        Flag.withDefault("."),
      ),
    },
    Effect.fn(`toolreader history hook ${action}`)(function* ({ repo }) {
      const lines = yield* installHooks((yield* Path.Path).resolve(repo), action);
      for (const line of lines) yield* Console.log(line);
    }),
  ).pipe(
    Command.withDescription(
      action === "install"
        ? "Opt this repo in: every push to origin sends its agent history, in the background"
        : "Opt this repo out and remove its history hooks",
    ),
  );

const skillCommand = (action: "install" | "uninstall") =>
  Command.make(
    action,
    {
      repo: Flag.string("repo").pipe(
        Flag.withDescription("Repository (any path inside it)"),
        Flag.withDefault("."),
      ),
      commit: Flag.boolean("commit").pipe(
        Flag.withDescription(
          "Commit what this changed, and nothing else (a file with other uncommitted changes is left to you)",
        ),
      ),
    },
    Effect.fn(`toolreader history skill ${action}`)(function* ({ repo, commit }) {
      const top = (yield* run((yield* Path.Path).resolve(repo), "git", [
        "rev-parse",
        "--show-toplevel",
      ])).trim();
      // Edits of yours in AGENTS.md or settings.json are never swept into our commit.
      const dirty = yield* dirtyPaths(top, INSTALLED_PATHS);
      const { lines, failed } = yield* installSkill(top, action);
      for (const line of lines) yield* Console.log(line);
      for (const why of failed) yield* Console.log(`! ${why}`);
      const ours = INSTALLED_PATHS.filter((p) => !dirty.includes(p));
      if (commit) {
        yield* Console.log(yield* commitSkill(top, action, ours));
        for (const p of dirty)
          yield* Console.log(`  ${p} had other uncommitted changes: commit it yourself`);
      } else
        yield* Console.log(
          `Commit ${action === "install" ? "these" : "the removal"} so every agent here gets ${action === "install" ? "them" : "it"} (or pass --commit).`,
        );
    }),
  ).pipe(
    Command.withDescription(
      action === "install"
        ? "Have agents declare which turns produced each commit: the skill, a rule in AGENTS.md and CLAUDE.md, and Claude Code's reminder after each commit"
        : "Remove the skill, the rule and the reminder (each left alone if edited)",
    ),
  );

export const historyCommand = Command.make("history").pipe(
  Command.withDescription("Agent history per commit, kept on the history backend"),
  Command.withSubcommands([
    sync,
    status,
    push,
    site,
    login,
    search,
    show,
    sql,
    media,
    Command.make("review").pipe(
      Command.withDescription("Frozen reviews: their whole decision context, reopened as it was"),
      Command.withSubcommands([freeze, reopen]),
    ),
    insights,
    Command.make("insight").pipe(
      Command.withDescription("Decide on a finding: each step is kept with who, when and why"),
      Command.withSubcommands([
        ...(Object.keys(DECISIONS) as Array<keyof typeof DECISIONS>).map(decision),
        submit,
        sample,
        score,
        members,
      ]),
    ),
    audit,
    ...declareCommands,
    Command.make("skill").pipe(
      Command.withDescription("The agent skill, committed once per repo"),
      Command.withSubcommands([skillCommand("install"), skillCommand("uninstall")]),
    ),
    Command.make("hook").pipe(
      Command.withDescription("The git hooks that send history as you push"),
      Command.withSubcommands([installer("install"), installer("uninstall")]),
    ),
  ]),
);
