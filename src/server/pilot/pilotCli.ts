import * as Console from "effect/Console";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { archiveReminder } from "../../core/codexArchive.ts";
import { HistoryFailed } from "../history/HistoryClient.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";
import { ServerConfig } from "../ServerConfig.ts";
import { syncPilot } from "./Pilot.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const pilotCommand = Command.make("pilot").pipe(
  Command.withSubcommands([
    Command.make(
      "remind",
      {},
      Effect.fn("pilot remind")(function* () {
        const input: string[] = [];
        let bytes = 0;
        yield* (yield* Stdio.Stdio).stdin.pipe(
          Stream.decodeText(),
          Stream.runForEach((part) => {
            bytes += Buffer.byteLength(part);
            if (bytes > 8 * 1024 * 1024)
              return Effect.fail(
                new HistoryFailed({
                  message: "Hook input exceeds 8 MiB. Run the history skill explicitly.",
                }),
              );
            input.push(part);
            return Effect.void;
          }),
        );
        const result = yield* Effect.try({
          try: () => archiveReminder(input.join("")),
          catch: () =>
            new HistoryFailed({ message: "Invalid hook input. Run the history skill explicitly." }),
        });
        if (result) yield* Console.log(encodeJson(result));
      }),
    ),
    Command.make(
      "sync",
      {
        repo: Flag.string("repo").pipe(Flag.withDefault(".")),
        session: Flag.string("session").pipe(Flag.optional),
        related: Flag.string("related").pipe(Flag.atLeast(0)),
        sha: Flag.string("sha").pipe(Flag.optional),
        role: Flag.choice("role", ["implemented", "tested", "reviewed", "deployed"]).pipe(
          Flag.withDefault("implemented"),
        ),
      },
      Effect.fn("pilot sync")(function* (flags) {
        yield* syncPilot({
          ...flags,
          session: Option.getOrUndefined(flags.session),
          sha: Option.getOrUndefined(flags.sha),
        }).pipe(Effect.provide(ServerConfig.layer));
      }),
    ).pipe(
      Command.withDescription(
        "Archive only this local Codex chat and direct message peers, with full available context; optionally link a commit",
      ),
    ),
  ]),
);
