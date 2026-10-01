// Commit ledger CLI:
//   vp run ledger -- sync [--repo PATH] [--range A..B] [--no-outputs]   write entries for agent commits
//   vp run ledger -- show [--repo PATH] [--range A..B]                   list commits and their history
// The range defaults to <default branch>..HEAD. Push the ledger with `git push origin agent-ledger`.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";

import packageJson from "../../package.json" with { type: "json" };
import { LEDGER_BRANCH } from "../core/ledger.ts";
import { AppLive } from "./app.ts";
import { Ledger } from "./Ledger.ts";

const repo = Flag.string("repo").pipe(
  Flag.withDescription("Repository (any path inside it)"),
  Flag.withDefault("."),
);
const range = Flag.string("range").pipe(
  Flag.withDescription("Commit range, e.g. main..HEAD (default: <default branch>..HEAD)"),
  Flag.optional,
);

const sync = Command.make(
  "sync",
  {
    repo,
    range,
    noOutputs: Flag.boolean("no-outputs").pipe(
      Flag.withDescription("Leave command and tool outputs out (they are redacted otherwise)"),
    ),
  },
  Effect.fn(function* ({ repo, range, noOutputs }) {
    const ledger = yield* Ledger;
    const result = yield* ledger.sync(repo, Option.getOrNull(range), !noOutputs);
    yield* Console.log(
      `${result.range}: ${result.added.length} added, ${result.existing} already in the ledger`,
    );
    for (const a of result.added) {
      yield* Console.log(
        `  + ${a.commit.sha.slice(0, 8)} ${a.commit.subject}  ← ${a.thread} (${a.actions} actions, by ${a.match})`,
      );
    }
    for (const c of result.unmatched) {
      yield* Console.log(`  · ${c.sha.slice(0, 8)} ${c.subject}  (no agent history found)`);
    }
    if (result.added.length > 0)
      yield* Console.log(`Push it with: git push origin ${LEDGER_BRANCH}`);
  }),
).pipe(Command.withDescription("Write ledger entries for agent-made commits in a range"));

const show = Command.make(
  "show",
  { repo, range },
  Effect.fn(function* ({ repo, range }) {
    const ledger = yield* Ledger;
    const view = yield* ledger.range(repo, Option.getOrNull(range));
    yield* Console.log(`${view.repo} ${view.range}`);
    for (const c of view.commits) {
      const e = c.entry;
      const detail = e
        ? `${e.thread.title} · ${e.entries.filter((x) => x.type === "action").length} actions${c.matchedBy === "patch-id" ? " · found by patch-id" : ""}`
        : "no agent history";
      yield* Console.log(`  ${c.commit.sha.slice(0, 8)} ${c.commit.subject}  — ${detail}`);
    }
  }),
).pipe(Command.withDescription("List commits in a range with their agent history"));

Command.make("ledger").pipe(
  Command.withDescription("Agent history per commit, kept on the agent-ledger branch"),
  Command.withSubcommands([sync, show]),
  Command.run({ version: packageJson.version }),
  Effect.provide(AppLive),
  NodeRuntime.runMain,
);
