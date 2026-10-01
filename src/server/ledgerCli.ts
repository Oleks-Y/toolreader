// Commit ledger CLI:
//   vp run ledger -- sync [--repo PATH] [--range A..B] [--source auto|t3|codex-app-server|codex-rollouts]
//                         [--codex-home DIR] [--max-output BYTES] [--no-outputs] [--push]
//   vp run ledger -- show [--repo PATH] [--range A..B]          list commits and their history
//   vp run ledger -- hook install|uninstall [--repo PATH]       pre-push hook: sync pushed commits, --push
// The range defaults to <default branch>..HEAD. Without --push, share it with `git push origin agent-ledger`.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Argument, Command, Flag } from "effect/unstable/cli";

import packageJson from "../../package.json" with { type: "json" };
import { LEDGER_BRANCH } from "../core/ledger.ts";
import { LedgerApp } from "./app.ts";
import { Ledger, LEDGER_SOURCES, SYNC_DEFAULTS } from "./Ledger.ts";

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
    push: Flag.boolean("push").pipe(
      Flag.withDescription(
        "Write on top of origin's agent-ledger and push it, retrying if another push wins",
      ),
    ),
  },
  Effect.fn(function* ({ repo, range, source, codexHome, maxOutput, noOutputs, push }) {
    const path = yield* Path.Path;
    const result = yield* Effect.flatMap(Ledger, (ledger) =>
      ledger.sync(repo, Option.getOrNull(range), {
        outputs: !noOutputs,
        maxOutput,
        source,
        push,
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
        `  + ${a.commit.sha.slice(0, 8)} ${a.commit.subject}  ← ${a.thread} (${a.actions} actions, by ${a.match})`,
      );
    }
    for (const c of result.unmatched) {
      yield* Console.log(`  · ${c.sha.slice(0, 8)} ${c.subject}  (no agent history found)`);
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
    const view = yield* Effect.flatMap(Ledger, (ledger) =>
      ledger.range(repo, Option.getOrNull(range)),
    ).pipe(Effect.provide(offline));
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

const hook = Command.make(
  "hook",
  { action: Argument.choice("action", ["install", "uninstall"]), repo },
  Effect.fn(function* ({ action, repo }) {
    // The hook runs this same CLI, with absolute paths so it works from any shell.
    const self = [process.execPath, import.meta.filename].map(
      (a) => `'${a.replace(/'/g, `'\\''`)}'`,
    );
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

Command.make("ledger").pipe(
  Command.withDescription("Agent history per commit, kept on the agent-ledger branch"),
  Command.withSubcommands([sync, show, hook]),
  Command.run({ version: packageJson.version }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
