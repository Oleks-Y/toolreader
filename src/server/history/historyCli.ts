// `toolreader history`: which agent turns wrote each commit, linked by the lines they added
// (core/history.ts), kept on the history backend (~/.toolreader/config.json).
//   toolreader history sync (--range A..B | --pr N | --sha X) [--repo PATH]
//                           [--source auto|t3|codex-app-server|codex-rollouts|claude-transcripts]
//                           [--dry-run]
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { redactText } from "../../core/proof.ts";
import { LedgerApp } from "../app.ts";
import { SESSION_SOURCES } from "../RepoSessions.ts";
import { HistoryFailed } from "./HistoryClient.ts";
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

/** Titles are a session's first prompt line: logs (CI's included) get them redacted. */
const title = (t: string) => redactText(t).text;

/** What `sync` did, a line each. */
export const reportLines = (report: SyncReport, dryRun: boolean): string[] => {
  const lines: string[] = [];
  for (const { record: c, titles } of report.commits) {
    lines.push(`${c.sha.slice(0, 8)} ${c.subject}`);
    for (const l of c.links)
      lines.push(
        l.via === "trailer"
          ? `  ✓ ${title(titles.get(l.threadId) ?? l.threadId)} (named by its trailer)`
          : `  ✓ ${title(titles.get(l.threadId) ?? l.threadId)} (${l.turns.length} turn${l.turns.length === 1 ? "" : "s"}, ${l.lines} line${l.lines === 1 ? "" : "s"})`,
      );
    lines.push(
      c.links.length === 0
        ? `  · no agent turn wrote its ${c.novel} new lines`
        : `  ${c.explained} of its ${c.novel} new lines written by these agents`,
    );
  }
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
    const report = yield* Effect.flatMap(HistorySync, (h) =>
      h.sync(repo, range, { source: flags.source, dryRun: flags.dryRun }),
    ).pipe(
      Effect.provide(
        LedgerApp({ appServer: flags.source === "codex-app-server", codexHome: null }),
      ),
    );
    for (const line of reportLines(report, flags.dryRun)) yield* Console.log(line);
  }),
).pipe(
  Command.withDescription(
    "Link a range's commits to the agent turns that wrote them, and send the threads and links to the backend",
  ),
);

export const historyCommand = Command.make("history").pipe(
  Command.withDescription("Agent history per commit, kept on the history backend"),
  Command.withSubcommands([sync]),
);
