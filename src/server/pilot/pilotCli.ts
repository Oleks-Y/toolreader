import * as Console from "effect/Console";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { archiveReminder } from "../../core/codexArchive.ts";
import { automaticSyncDecision } from "../../core/syncStrategy.ts";
import { HistoryFailed } from "../history/HistoryClient.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";
import { ServerConfig } from "../ServerConfig.ts";
import { recordHook } from "./capture.ts";
import { launchDetachedSync, markDetachedSync } from "./detachedSync.ts";
import { backfillPilot } from "./backfill.ts";
import { syncPilot } from "./Pilot.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const selectedBackfillCommand = Command.make(
  "backfill",
  {
    repo: Flag.string("repo").pipe(Flag.optional),
    includeDirs: Flag.string("include-dir").pipe(Flag.atLeast(0)),
  },
  Effect.fn("history backfill")(function* (flags) {
    yield* backfillPilot({
      repo: Option.getOrUndefined(flags.repo),
      includeDirs: flags.includeDirs,
    });
  }),
).pipe(
  Command.withDescription("Backfill legacy exact Codex imports from available local source files"),
);

export const selectedHookCommand = Command.make(
  "hook-event",
  {},
  Effect.fn("history hook-event")(function* () {
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
    const config = yield* ServerConfig;
    const text = input.join("");
    yield* Effect.tryPromise({
      try: () => recordHook(config.codexHome, text),
      catch: () => new HistoryFailed({ message: "Hook history capture failed; nothing uploaded" }),
    });
    const result = yield* Effect.try({
      try: () => archiveReminder(text),
      catch: () =>
        new HistoryFailed({ message: "Invalid hook input. Run the history skill explicitly." }),
    });
    if (result) yield* Console.log(encodeJson(result));
    const decision = yield* Effect.try({
      try: () => automaticSyncDecision(text, process.env.TOOLREADER_SYNC_STRATEGY),
      catch: () => new HistoryFailed({ message: "Invalid sync strategy or hook event" }),
    });
    if (decision.sync) {
      if (decision.detached) {
        yield* Effect.tryPromise({
          try: () => launchDetachedSync(config.codexHome, decision.session, decision.repo),
          catch: () => new HistoryFailed({ message: "Could not start the detached session sync" }),
        });
        return;
      }
      yield* syncPilot({
        repo: decision.repo,
        session: decision.session,
        related: [],
        includeDirs: [],
        retainExact: false,
        sha: decision.linkHead ? "HEAD" : undefined,
        role: "implemented",
        quiet: true,
      });
    }
  }, Effect.provide(ServerConfig.layer)),
);

// Only SessionEnd starts this command. It owns the long upload after the hook returns.
export const selectedHookSyncCommand = Command.make(
  "hook-sync",
  {
    session: Flag.string("session"),
    repo: Flag.string("repo"),
  },
  Effect.fn("history hook-sync")(function* ({ session, repo }) {
    const config = yield* ServerConfig;
    const mark = (state: "running" | "succeeded" | "failed") =>
      Effect.tryPromise({
        try: () => markDetachedSync(config.codexHome, session, state),
        catch: () => new HistoryFailed({ message: "Could not write session sync status" }),
      });
    yield* mark("running");
    yield* syncPilot({
      repo,
      session,
      related: [],
      includeDirs: [],
      retainExact: false,
      sha: undefined,
      role: "implemented",
      quiet: true,
    }).pipe(
      Effect.tap(() => mark("succeeded")),
      Effect.tapError(() => mark("failed")),
    );
  }, Effect.provide(ServerConfig.layer)),
);

export const selectedSyncCommand = Command.make(
  "sync",
  {
    range: Flag.string("range").pipe(Flag.optional),
    pr: Flag.integer("pr").pipe(Flag.optional),
    hook: Flag.boolean("hook"),
    repo: Flag.string("repo").pipe(Flag.withDefault(".")),
    session: Flag.string("session").pipe(Flag.optional),
    related: Flag.string("related").pipe(Flag.atLeast(0)),
    includeDirs: Flag.string("include-dir").pipe(Flag.atLeast(0)),
    redactFile: Flag.string("redact-file").pipe(Flag.optional),
    retainExact: Flag.boolean("retain-exact"),
    sha: Flag.string("sha").pipe(Flag.optional),
    role: Flag.choice("role", ["implemented", "tested", "reviewed", "deployed"]).pipe(
      Flag.withDefault("implemented"),
    ),
  },
  Effect.fn("history sync")(function* (flags) {
    const { redactFile, range, pr, hook, ...rest } = flags;
    if (Option.isSome(range) || Option.isSome(pr) || hook)
      return yield* new HistoryFailed({
        message:
          "This is an older history sync command. Reinstall the repo's toolreader hooks; no history was uploaded.",
      });
    yield* syncPilot({
      ...rest,
      ...(Option.isSome(redactFile) ? { redactFile: redactFile.value } : {}),
      session: Option.getOrUndefined(flags.session),
      sha: Option.getOrUndefined(flags.sha),
    }).pipe(Effect.provide(ServerConfig.layer));
  }),
).pipe(
  Command.withDescription(
    "Sync this Codex chat and direct peers as filtered history; optionally link a commit and include directories",
  ),
);
