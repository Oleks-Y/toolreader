// Proof-of-work export for agents and scripts:
//   toolreader export <threadId> [--turns 3-5] [--from ISO --to ISO] [--no-outputs] [--repo PATH] [--stdout]
// Writes <repo>/.agent-work/<branch>/<name>.json (repo defaults to the thread's working directory).
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { InvalidProofScope } from "../core/api.ts";
import { AppLive } from "./app.ts";
import { parseTurns, Proofs } from "./Proofs.ts";
import { ServerConfig } from "./ServerConfig.ts";

export const exportCommand = Command.make(
  "export",
  {
    threadId: Argument.string("thread-id").pipe(
      Argument.withDescription("T3 thread id, or codex:<id> for a Codex session"),
    ),
    turns: Flag.string("turns").pipe(
      Flag.withDescription("Turns to include, as shown in the viewer: 3 or 3-5"),
      Flag.optional,
    ),
    from: Flag.string("from").pipe(
      Flag.withDescription("Start of a time range (ISO)"),
      Flag.optional,
    ),
    to: Flag.string("to").pipe(Flag.withDescription("End of a time range (ISO)"), Flag.optional),
    noOutputs: Flag.boolean("no-outputs").pipe(
      Flag.withDescription("Leave command and tool outputs out (they are redacted otherwise)"),
    ),
    repo: Flag.string("repo").pipe(
      Flag.withDescription("Repo to write into; defaults to the thread's working directory"),
      Flag.optional,
    ),
    stdout: Flag.boolean("stdout").pipe(
      Flag.withDescription("Print the JSON instead of writing a file"),
    ),
  },
  Effect.fn(function* ({ threadId, turns, from, to, noOutputs, repo, stdout }) {
    const parsedTurns = Option.flatMap(turns, parseTurns);
    if (Option.isSome(turns) && Option.isNone(parsedTurns)) {
      return yield* new InvalidProofScope({
        message: `--turns must look like 3 or 3-5, got "${turns.value}"`,
      });
    }
    const range =
      Option.isSome(from) && Option.isSome(to) ? { from: from.value, to: to.value } : null;
    const proofs = yield* Proofs;
    const artifact = yield* proofs.build({
      threadId,
      scope: { turns: Option.getOrNull(parsedTurns), range },
      outputs: !noOutputs,
      repo: Option.getOrUndefined(repo),
    });
    if (stdout) return yield* Console.log(yield* proofs.render(artifact));
    const { home } = yield* ServerConfig;
    // The artifact's worktree is shown as ~/…; expand it back to write there.
    const target =
      Option.getOrNull(repo) ?? artifact.view.thread.worktree?.replace(/^~(?=\/|$)/, home);
    if (!target) {
      return yield* new InvalidProofScope({
        message: "The thread has no working directory; pass --repo",
      });
    }
    const file = yield* proofs.write(artifact, target);
    yield* Console.log(
      `${file}\n${artifact.view.entries.length} entries · outputs ${artifact.outputs} · ${artifact.redactions} redactions`,
    );
  }, Effect.provide(AppLive)),
).pipe(
  Command.withDescription(
    "Export a thread (or some of its turns) as a proof-of-work JSON artifact",
  ),
);
