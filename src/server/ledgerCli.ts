// `toolreader ledger`:
//   toolreader ledger sync [--repo PATH] [--range A..B] [--source auto|t3|codex-app-server|codex-rollouts]
//                         [--codex-home DIR] [--max-output BYTES] [--no-outputs] [--push]
//                         [--match-sessions | --session ID ...]
//   toolreader ledger show [--repo PATH] [--range A..B]          list commits and their history
//   toolreader ledger site [--repo PATH] [--range A..B] [--out DIR]  static page of the range
//   toolreader ledger hook install|uninstall [--repo PATH]       pre-push hook: sync pushed commits, --push
// The range defaults to <default branch>..HEAD. Without --push, share it with `git push origin agent-ledger`.
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { LEDGER_BRANCH } from "../core/ledger.ts";
import { publicRange } from "../core/ledgerSite.ts";
import { redactText } from "../core/proof.ts";
import { LedgerApp } from "./app.ts";
import { Ledger, LEDGER_SOURCES, SYNC_DEFAULTS } from "./Ledger.ts";
import { ServerConfig } from "./ServerConfig.ts";

const repo = Flag.string("repo").pipe(
  Flag.withDescription("Repository (any path inside it)"),
  Flag.withDefault("."),
);
const range = Flag.string("range").pipe(
  Flag.withDescription(
    "Commits to sync, as `git log` takes them: main..HEAD, or `SHA --not --remotes=origin` (default: <default branch>..HEAD)",
  ),
  Flag.optional,
);
const offline = LedgerApp({ appServer: false, codexHome: null });
/** Commit subjects come straight from git; CI logs are as public as the page. */
const subject = (s: string) => redactText(s).text;

const sync = Command.make(
  "sync",
  {
    repo,
    range,
    source: Flag.choice("source", LEDGER_SOURCES).pipe(
      Flag.withDescription(
        "Where sessions come from. auto: T3 if its database exists, plus Codex rollout files",
      ),
      Flag.withDefault(SYNC_DEFAULTS.source),
    ),
    codexHome: Flag.string("codex-home").pipe(
      Flag.withDescription("Codex home with sessions/ (default: $CODEX_HOME or ~/.codex)"),
      Flag.optional,
    ),
    maxOutput: Flag.integer("max-output").pipe(
      Flag.withDescription("Bytes kept per action output, head and tail (0 keeps it whole)"),
      Flag.withDefault(SYNC_DEFAULTS.maxOutput),
    ),
    noOutputs: Flag.boolean("no-outputs").pipe(
      Flag.withDescription("Leave command and tool outputs out (they are redacted otherwise)"),
    ),
    matchSessions: Flag.boolean("match-sessions").pipe(
      Flag.withDescription(
        "Tie a commit no `git commit` action made to the one session here that edited files and ended before it (safe with a job-local CODEX_HOME)",
      ),
    ),
    session: Flag.string("session").pipe(
      Flag.withDescription("Tie such commits to this session (repeatable)"),
      Flag.atLeast(0),
    ),
    push: Flag.boolean("push").pipe(
      Flag.withDescription(
        "Write on top of origin's agent-ledger and push it, retrying if another push wins",
      ),
    ),
  },
  Effect.fn(function* ({
    repo,
    range,
    source,
    codexHome,
    maxOutput,
    noOutputs,
    push,
    matchSessions,
    session,
  }) {
    const path = yield* Path.Path;
    const result = yield* Effect.flatMap(Ledger, (ledger) =>
      ledger.sync(repo, Option.getOrNull(range), {
        outputs: !noOutputs,
        maxOutput,
        source,
        push,
        matchSessions,
        sessions: session,
      }),
    ).pipe(
      Effect.provide(
        LedgerApp({
          appServer: source === "codex-app-server",
          codexHome: Option.getOrNull(Option.map(codexHome, (dir) => path.resolve(dir))),
        }),
      ),
    );
    yield* Console.log(
      `${result.range} (${result.sources.join(" + ") || "no sources"}): ${result.added.length} added, ${result.existing} already in the ledger`,
    );
    for (const a of result.added) {
      yield* Console.log(
        `  + ${a.commit.sha.slice(0, 8)} ${subject(a.commit.subject)}  ← ${a.thread} (${a.actions} actions, by ${a.match})`,
      );
    }
    for (const { commit: c, sessions } of result.ambiguous) {
      yield* Console.log(
        `  ? ${c.sha.slice(0, 8)} ${subject(c.subject)}  (ambiguous: ${sessions.join(", ")}; pick one with --session)`,
      );
    }
    for (const c of result.unmatched) {
      yield* Console.log(
        `  · ${c.sha.slice(0, 8)} ${subject(c.subject)}  (no agent history found)`,
      );
    }
    if (result.pushed) yield* Console.log(`Pushed ${LEDGER_BRANCH} ${result.pushed.slice(0, 8)}`);
    else if (!push && result.added.length > 0)
      yield* Console.log(`Push it with: git push origin ${LEDGER_BRANCH}`);
  }),
).pipe(Command.withDescription("Write ledger entries for agent-made commits in a range"));

const show = Command.make(
  "show",
  { repo, range },
  Effect.fn(function* ({ repo, range }) {
    // Its output goes to CI logs and job summaries: print the public view.
    const view = yield* Effect.gen(function* () {
      const { home } = yield* ServerConfig;
      const ledger = yield* Ledger;
      return publicRange(yield* ledger.range(repo, Option.getOrNull(range)), home);
    }).pipe(Effect.provide(offline));
    yield* Console.log(`${view.repo} ${view.range}`);
    for (const c of view.commits) {
      const e = c.entry;
      const detail = e
        ? `${e.thread.title} · ${e.entries.filter((x) => x.type === "action").length} actions · by ${e.match}${c.matchedBy === "patch-id" ? " · found by patch-id" : ""}`
        : "no agent history";
      yield* Console.log(`  ${c.commit.sha.slice(0, 8)} ${c.commit.subject}  — ${detail}`);
    }
  }),
).pipe(Command.withDescription("List commits in a range with their agent history"));

const site = Command.make(
  "site",
  {
    repo,
    range,
    out: Flag.string("out").pipe(
      Flag.withDescription("Directory to write index.html into"),
      Flag.withDefault("ledger-site"),
    ),
  },
  Effect.fn(function* ({ repo, range, out }) {
    const { file, view } = yield* Effect.flatMap(Ledger, (ledger) =>
      ledger.site(repo, Option.getOrNull(range), out),
    ).pipe(Effect.provide(offline));
    const withHistory = view.commits.filter((c) => c.entry).length;
    yield* Console.log(
      `${file}\n${view.range}: ${view.commits.length} commits, ${withHistory} with agent history`,
    );
  }),
).pipe(
  Command.withDescription(
    "Write a self-contained page of a range's agent history (opens from file:// or any static host)",
  ),
);

const hook = Command.make(
  "hook",
  { action: Argument.choice("action", ["install", "uninstall"]), repo },
  Effect.fn(function* ({ action, repo }) {
    // The hook runs this same CLI (the script node started: bin.ts, or the bundled dist/bin.mjs),
    // with absolute paths so it works from any shell.
    const path = yield* Path.Path;
    const self = [process.execPath, path.resolve(process.argv[1]!)]
      .map((a) => `'${a.replace(/'/g, `'\\''`)}'`)
      .concat("ledger");
    const message = yield* Effect.flatMap(Ledger, (ledger) =>
      ledger.hook(repo, action, self.join(" ")),
    ).pipe(Effect.provide(offline));
    yield* Console.log(message);
  }),
).pipe(
  Command.withDescription(
    "Install or remove a pre-push hook that syncs the pushed commits and pushes agent-ledger",
  ),
);

export const ledgerCommand = Command.make("ledger").pipe(
  Command.withDescription("Agent history per commit, kept on the agent-ledger branch"),
  Command.withSubcommands([sync, show, site, hook]),
);
