// `toolreader history`: which agent turns wrote each commit, linked by the lines they added
// (core/history.ts), kept on the history backend (~/.toolreader/config.json).
//   toolreader history sync (--range A..B | --pr N | --sha X) [--repo PATH]
//                           [--source auto|t3|codex-app-server|codex-rollouts|claude-transcripts]
//                           [--dry-run] [--hook]
//   toolreader history site (--range A..B | --pr N) [--repo PATH] [--out DIR]
//   toolreader history audit [--repo PATH] [--source …]           (core/audit.ts)
//   toolreader history search TEXT [--repo PATH] [--all] [--limit N]
//   toolreader history turns|link|unlink …                       (declareCli.ts)
//   toolreader history skill install|uninstall [--repo PATH] [--commit]   (historySkill.ts)
//   toolreader history hook install|uninstall [--repo PATH]    (historyHooks.ts)
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { auditLines, auditSessions } from "../../core/audit.ts";
import { CHECK_KINDS, type Check } from "../../core/checks.ts";
import { redactText } from "../../core/proof.ts";
import { CliApp } from "../app.ts";
import { RepoSessions, SESSION_SOURCES } from "../RepoSessions.ts";
import { ServerConfig } from "../ServerConfig.ts";
import { declareCommands } from "./declareCli.ts";
import { HistoryFailed } from "./HistoryClient.ts";
import { commitSkill, dirtyPaths, INSTALLED_PATHS, installSkill } from "./historySkill.ts";
import { appendLog, causeMessage, installHooks, pending } from "./historyHooks.ts";
import type { SearchHit } from "../../core/historyApi.ts";
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
          `    read ${l.reads.paths.length + l.reads.more} files for it (as its read actions show)`,
        );
    }
    lines.push(
      c.links.length === 0
        ? `  · no agent turn wrote its ${c.novel} new lines`
        : `  ${c.explained} of its ${c.novel} new lines match these agents' edits`,
    );
  }
  for (const why of report.ignored) lines.push(`! ignored ${title(why)}`);
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
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const common = (yield* spawner
        .string(
          ChildProcess.make("git", [
            "-C",
            repo,
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          ]),
        )
        .pipe(Effect.orElseSucceed(() => repo))).trim();
      const store = yield* pending(common);
      const lines: string[] = [];
      for (const r of new Set([...(yield* store.list), range])) {
        const done = yield* Effect.result(syncRange(r));
        if (done._tag === "Success") {
          lines.push(...reportLines(done.success, false));
          yield* store.done(r);
        } else {
          yield* store.add(r);
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
    "Link a range's commits to the agent turns that wrote them, and send the threads and links to the backend",
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
      Argument.withDescription("What to find, in any case: an error, a command, a path"),
    ),
    repo: Flag.string("repo").pipe(
      Flag.withDescription("Repository (any path inside it): searches its sessions"),
      Flag.withDefault("."),
    ),
    all: Flag.boolean("all").pipe(
      Flag.withDescription("Search every session in the workspace, not only this repo's"),
    ),
    limit: Flag.integer("limit").pipe(Flag.withDescription("Hits to show"), Flag.withDefault(20)),
  },
  Effect.fn("toolreader history search")(function* (flags) {
    const repo = (yield* Path.Path).resolve(flags.repo);
    const { hits, truncated } = yield* Effect.flatMap(HistorySync, (h) =>
      h.search(repo, flags.text, { all: flags.all, limit: flags.limit }),
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
    site,
    search,
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
