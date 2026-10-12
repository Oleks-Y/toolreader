// `toolreader checkpoint`: stores agent history as it is now, with model and token usage, so it
// outlives the session's own store, in Postgres at TOOLREADER_DATABASE_URL.
//   toolreader checkpoint put --session ID [--repo PATH] [--replace]
//                             [--max-output BYTES] [--no-outputs]
//   toolreader checkpoint collect (--range A..B | --pr N | --sha X) [--repo PATH]
//                             [--source auto|t3|codex-app-server|codex-rollouts|claude-transcripts]
//                             [--match-sessions | --session ID ...] [--replace]
//                             [--max-output BYTES] [--no-outputs]
// ID is a T3 thread id, codex:<id>, claude-code:<id> (what agents export) or claude:<id>.
// `collect` stores each link of the scope's commits (docs/design/checkpoint-scope.md), and lists
// the sessions only signals point at, for a person to link. Taking the same checkpoint again stores
// nothing; --replace overwrites it if its content changed.
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { FoundLink, LedgerCommit, LinkVia } from "../../core/ledger.ts";
import type { LinkCommit } from "../../core/linking.ts";
import { redactText } from "../../core/proof.ts";
import { CheckpointApp } from "../app.ts";
import {
  CheckpointFailed,
  Checkpoints,
  CheckpointSink,
  type Flushed,
  type Sent,
} from "./Checkpoints.ts";
import { Ledger, LEDGER_SOURCES, SYNC_DEFAULTS, type ScopeOptions } from "../Ledger.ts";

const mark = (result: Sent | "failed") =>
  result === "failed" || result === "rejected"
    ? "✗"
    : result === "exists" || result === "differs"
      ? "·"
      : result === "queued"
        ? "…"
        : "✓";

/** What the outbox sent, why it stopped, and what waits for another backend. */
const flushedLines = (flushed: Flushed) => [
  ...flushed.sent.map(
    (f) =>
      `${mark(f.result)} ${f.id}  ${f.result} (from the outbox)${f.detail ? `: ${f.detail}` : ""}`,
  ),
  ...(flushed.blocked ? [`… the outbox waits: ${flushed.blocked}`] : []),
  ...(flushed.elsewhere > 0
    ? [
        `· ${flushed.elsewhere} queued for another backend, workspace or toolreader version, left in ~/.toolreader/outbox (delete them there if that backend is gone)`,
      ]
    : []),
];

const PullRequest = Schema.Struct({ baseRefOid: Schema.String, headRefOid: Schema.String });
const decodePullRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(PullRequest));

export type CollectOptions = Omit<ScopeOptions, "here"> & {
  readonly repo: string;
  /** Exactly one: collect never sweeps without a scope. */
  readonly scope: { readonly range: string } | { readonly pr: number } | { readonly sha: string };
  readonly replace: boolean;
  readonly outputs: boolean;
  readonly maxOutput: number;
};

type Taken = {
  readonly title: string;
  readonly via: LinkVia;
  readonly id: string | null;
  readonly result: Sent | "failed";
  /** Why it was queued, rejected or failed. */
  readonly detail: string | null;
};
export type CommitReport = {
  readonly commit: LedgerCommit;
  readonly taken: Taken[];
  /** Sessions only signals point at: not stored; a person decides with `ledger link`. */
  readonly candidates: Array<{ readonly title: string; readonly signals: ReadonlyArray<string> }>;
  ambiguous: ReadonlyArray<string> | null;
  unmatched: boolean;
  /** Threads `ledger unlink` took off this commit: skipped. */
  readonly unlinked: string[];
};

/** Titles are a session's first prompt line: logs (CI's included) get them redacted. */
const title = (t: string) => redactText(t).text;

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
      return yield* new CheckpointFailed({
        message: `${command} ${args.join(" ")}: ${stderr.trim() || `exit ${exitCode}`}`,
      });
    return stdout;
  }).pipe(
    Effect.scoped,
    Effect.catchTag("PlatformError", (e) =>
      Effect.fail(new CheckpointFailed({ message: e.message })),
    ),
  );

/**
 * `--pr N`: its base..head, fetching the head when it isn't local. Evidence and signals come from
 * the worktree whose HEAD is the PR head, if one is; else from the repo collect runs in.
 */
const prScope = Effect.fn("Checkpoints.prScope")(function* (repo: string, pr: number) {
  const { baseRefOid: base, headRefOid: head } = yield* run(repo, "gh", [
    "pr",
    "view",
    String(pr),
    "--json",
    "baseRefOid,headRefOid",
  ]).pipe(
    Effect.flatMap(decodePullRequest),
    Effect.mapError((e) => new CheckpointFailed({ message: `PR ${pr}: ${e.message}` })),
  );
  const has = (sha: string) =>
    run(repo, "git", ["cat-file", "-e", `${sha}^{commit}`]).pipe(Effect.isSuccess);
  if (!(yield* has(head))) yield* run(repo, "git", ["fetch", "-q", "origin", `pull/${pr}/head`]);
  if (!(yield* has(base))) yield* run(repo, "git", ["fetch", "-q", "origin", base]);
  const listing = yield* run(repo, "git", ["worktree", "list", "--porcelain"]);
  const here = listing
    .split("\n\n")
    .map((block) => block.split("\n"))
    .find((lines) => lines.includes(`HEAD ${head}`))?.[0]
    ?.slice("worktree ".length);
  return { range: `${base}..${head}`, here };
});

/**
 * Takes a commit checkpoint of every link in scope (`Ledger.scope`), except threads the ledger
 * has unlinked from that commit. Sessions only signals point at are listed, never stored.
 */
export const collect = Effect.fn("Checkpoints.collect")(function* (options: CollectOptions) {
  const ledger = yield* Ledger;
  const checkpoints = yield* Checkpoints;
  const toFailed = Effect.mapError(
    (e: { readonly message: string }) => new CheckpointFailed({ message: e.message }),
  );

  const { range, here } =
    "range" in options.scope
      ? { range: options.scope.range, here: undefined }
      : "sha" in options.scope
        ? { range: `-1 ${options.scope.sha}`, here: undefined }
        : yield* prScope(options.repo, options.scope.pr);
  const { repo, roots, scope } = yield* ledger
    .scope(options.repo, range, {
      source: options.source,
      sessions: options.sessions,
      matchSessions: options.matchSessions,
      ...(here ? { here } : {}),
    })
    .pipe(toFailed);
  const views = yield* ledger.range(repo, range).pipe(toFailed);
  const unlinked = new Map(views.commits.map((v) => [v.commit.sha, new Set(v.entry?.unlinked)]));

  const reports = new Map<string, CommitReport>();
  const report = (commit: LedgerCommit) => {
    const r: CommitReport = reports.get(commit.sha) ?? {
      commit,
      taken: [],
      candidates: [],
      ambiguous: null,
      unmatched: false,
      unlinked: [],
    };
    reports.set(commit.sha, r);
    return r;
  };
  // Oldest first, as git lists them.
  for (const v of views.commits) report(v.commit);
  const isUnlinked = (commit: LedgerCommit, thread: string) => {
    if (!unlinked.get(commit.sha)?.has(thread)) return false;
    report(commit).unlinked.push(thread);
    return true;
  };
  const take = (link: { readonly commit: LinkCommit; readonly found: FoundLink }) =>
    checkpoints
      .take({
        trigger: "commit",
        link,
        roots,
        repo: here ?? repo,
        replace: options.replace,
        outputs: options.outputs,
        maxOutput: options.maxOutput,
      })
      .pipe(
        Effect.map(
          ({ checkpoint, result, detail }): Taken => ({
            title: title(link.found.thread.title),
            via: link.found.via,
            id: checkpoint.id,
            result,
            detail,
          }),
        ),
        Effect.catch((e) =>
          Effect.succeed<Taken>({
            title: title(link.found.thread.title),
            via: link.found.via,
            id: null,
            result: "failed",
            detail: e.message,
          }),
        ),
        Effect.tap((t) => Effect.sync(() => report(link.commit.commit).taken.push(t))),
      );

  for (const { commit, link } of scope.take) {
    if (isUnlinked(commit.commit, link.thread.id)) continue;
    yield* take({ commit, found: link });
  }
  for (const { commit, sessions } of scope.ambiguous) report(commit.commit).ambiguous = sessions;
  for (const commit of scope.unmatched) report(commit.commit).unmatched = true;

  for (const j of scope.candidates)
    if (!isUnlinked(j.commit.commit, j.thread.id))
      report(j.commit.commit).candidates.push({
        title: title(j.thread.title),
        signals: j.signals.map((s) => s.kind),
      });

  return {
    repo,
    range: "sha" in options.scope ? options.scope.sha : range,
    commits: [...reports.values()],
  } as const;
});

const sourceFlag = Flag.choice("source", LEDGER_SOURCES).pipe(
  Flag.withDescription(
    "Where sessions come from. auto: T3 if its database exists, plus Codex rollout files and Claude Code transcripts",
  ),
  Flag.withDefault(SYNC_DEFAULTS.source),
);
const replaceFlag = Flag.boolean("replace").pipe(
  Flag.withDescription("Overwrite a stored checkpoint whose content changed"),
);
const maxOutputFlag = Flag.integer("max-output").pipe(
  Flag.withDescription("Bytes kept per action output, head and tail (0 keeps it whole)"),
  Flag.withDefault(8192),
);
const noOutputsFlag = Flag.boolean("no-outputs").pipe(
  Flag.withDescription("Leave command and tool outputs out (they are redacted otherwise)"),
);

/** What `collect` did, a line each. */
export const collectReport = (
  flushed: Flushed,
  result: { readonly range: string; readonly commits: ReadonlyArray<CommitReport> },
) => {
  const lines = flushedLines(flushed);
  lines.push(
    `${result.range}: ${result.commits.length} commit${result.commits.length === 1 ? "" : "s"}`,
  );
  let failed = 0;
  for (const r of result.commits) {
    lines.push(`${r.commit.sha.slice(0, 8)} ${title(r.commit.subject)}`);
    for (const t of r.taken) {
      if (t.result === "failed" || t.result === "rejected") failed++;
      lines.push(
        t.result === "failed"
          ? `  ✗ ${t.title} (by ${t.via}): ${t.detail}`
          : `  ${mark(t.result)} ${t.id}  ${t.result}  (by ${t.via})${t.detail ? `: ${t.detail}` : ""}`,
      );
    }
    for (const c of r.candidates)
      lines.push(
        `  ? ${c.title}: possibly related (${c.signals.join(", ")}); not stored, link it with ledger link`,
      );
    if (r.ambiguous)
      lines.push(`  ? ambiguous: ${r.ambiguous.join(", ")}; pick one with --session`);
    if (r.unmatched) lines.push("  · no session links it");
    for (const t of r.unlinked) lines.push(`  - ${t}: unlinked in the ledger, skipped`);
  }
  return { lines, failure: failed > 0 ? `${failed} checkpoint(s) failed or were rejected` : null };
};

const put = Command.make(
  "put",
  {
    session: Flag.string("session").pipe(
      Flag.withDescription(
        "The session: a T3 thread id, codex:<id>, claude-code:<id> or claude:<id>",
      ),
    ),
    repo: Flag.string("repo").pipe(
      Flag.withDescription("Repository it belongs to (default: the session's directory)"),
      Flag.optional,
    ),
    replace: replaceFlag,
    maxOutput: maxOutputFlag,
    noOutputs: noOutputsFlag,
  },
  Effect.fn("toolreader checkpoint put")(function* ({
    session,
    repo,
    replace,
    maxOutput,
    noOutputs,
  }) {
    const path = yield* Path.Path;
    const {
      checkpoint: cp,
      result,
      detail,
    } = yield* Effect.gen(function* () {
      // Printed first: what the outbox did stands even if this take fails.
      const flushed = yield* Effect.flatMap(CheckpointSink, (s) => s.flush());
      for (const line of flushedLines(flushed)) yield* Console.log(line);
      const taken = yield* Effect.flatMap(Checkpoints, (c) =>
        c.take({
          session,
          trigger: "manual",
          repo: Option.getOrNull(Option.map(repo, (r) => path.resolve(r))),
          replace,
          outputs: !noOutputs,
          maxOutput,
        }),
      );
      return taken;
    }).pipe(Effect.provide(CheckpointApp()));
    const actions = cp.turns.reduce((n, t) => n + t.stats.actions, 0);
    const models = [...new Set(cp.turns.flatMap((t) => (t.model ? [t.model] : [])))];
    yield* Console.log(`${mark(result)} ${cp.id}  ${result}${detail ? `: ${detail}` : ""}`);
    if (result === "differs")
      yield* Console.log(
        "  the stored checkpoint differs from this one and was kept; --replace overwrites it",
      );
    yield* Console.log(
      `  ${cp.repo.name} · ${cp.turns.length} turns · ${actions} actions · ${cp.filesTouched.length} files · ${cp.redactions} redactions`,
    );
    if (models.length > 0) yield* Console.log(`  model ${models.join(", ")}`);
    if (result === "rejected")
      return yield* new CheckpointFailed({ message: `The backend rejected ${cp.id}` });
  }),
).pipe(Command.withDescription("Store a session's history as one checkpoint"));

const collectCommand = Command.make(
  "collect",
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
    source: sourceFlag,
    matchSessions: Flag.boolean("match-sessions").pipe(
      Flag.withDescription(
        "Tie a commit no `git commit` action made to the one session here that edited files and ended before it (safe with a job-local CODEX_HOME)",
      ),
    ),
    session: Flag.string("session").pipe(
      Flag.withDescription("Tie such commits to this session (repeatable)"),
      Flag.atLeast(0),
    ),
    replace: replaceFlag,
    maxOutput: maxOutputFlag,
    noOutputs: noOutputsFlag,
  },
  Effect.fn("toolreader checkpoint collect")(function* (flags) {
    const path = yield* Path.Path;
    const repo = path.resolve(flags.repo);
    const given: Array<CollectOptions["scope"]> = [
      ...Option.toArray(Option.map(flags.range, (range) => ({ range }))),
      ...Option.toArray(Option.map(flags.pr, (pr) => ({ pr }))),
      ...Option.toArray(Option.map(flags.sha, (sha) => ({ sha }))),
    ];
    if (given.length !== 1)
      return yield* new CheckpointFailed({
        message: "Give exactly one of --range A..B, --pr N or --sha X",
      });
    const work = Effect.gen(function* () {
      // What earlier runs couldn't send goes first.
      const flushed = yield* Effect.flatMap(CheckpointSink, (s) => s.flush());
      const collected = yield* collect({
        repo,
        scope: given[0]!,
        source: flags.source,
        sessions: flags.session,
        matchSessions: flags.matchSessions,
        replace: flags.replace,
        outputs: !flags.noOutputs,
        maxOutput: flags.maxOutput,
      }).pipe(Effect.result);
      // A failed collection still reports what the outbox did.
      return Result.isSuccess(collected)
        ? collectReport(flushed, collected.success)
        : { lines: flushedLines(flushed), failure: collected.failure.message };
    }).pipe(Effect.provide(CheckpointApp({ appServer: flags.source === "codex-app-server" })));
    const { lines, failure } = yield* work;
    for (const line of lines) yield* Console.log(line);
    if (failure) return yield* new CheckpointFailed({ message: failure });
  }),
).pipe(
  Command.withDescription(
    "Store the sessions linked to a range's commits (--range, --pr or --sha), one checkpoint per link",
  ),
);

export const checkpointCommand = Command.make("checkpoint").pipe(
  Command.withDescription("Agent history per commit, stored in Postgres (TOOLREADER_DATABASE_URL)"),
  Command.withSubcommands([put, collectCommand]),
);
