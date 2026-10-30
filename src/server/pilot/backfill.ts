import * as Console from "effect/Console";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { rolloutMeta } from "../../core/rolloutThread.ts";
import { backendSettings, call, connect, HistoryFailed } from "../history/HistoryClient.ts";
import { ServerConfig } from "../ServerConfig.ts";
import { archiveLines } from "./io.ts";
import { findArtifact, syncPilot } from "./Pilot.ts";

export type BackfillOptions = {
  readonly repo: string | undefined;
  readonly includeDirs: ReadonlyArray<string>;
};

async function recordedDirectory(home: string, sessionId: string) {
  const file = await findArtifact(home, sessionId);
  for await (const line of archiveLines(file)) {
    const meta = rolloutMeta(line);
    if (meta?.id !== sessionId || !meta.cwd)
      throw new Error("Local rollout has no matching session metadata or working directory");
    return meta.cwd;
  }
  throw new Error("Local rollout is empty");
}

/** Revisit only sessions the backend reports as legacy exact copies. */
export const backfillPilot = Effect.fn("Pilot.backfill")(
  function* (options: BackfillOptions) {
    const settings = yield* backendSettings();
    const config = yield* ServerConfig;
    const api = yield* connect(settings);
    const params = { ws: settings.workspace };
    const before = yield* call(api.history.codexInventory({ params, payload: {} }));
    const legacy = before.artifacts.filter((a) => a.copyKind === "exact");
    const failures = new Map<string, string>();
    for (const sessionId of new Set(legacy.map((a) => a.sessionId))) {
      const result = yield* Effect.exit(
        Effect.gen(function* () {
          const repo =
            options.repo ??
            (yield* Effect.tryPromise({
              try: () => recordedDirectory(config.codexHome, sessionId),
              catch: (error) =>
                new HistoryFailed({
                  message: error instanceof Error ? error.message : "Local rollout cannot be read",
                }),
            }));
          yield* syncPilot({
            repo,
            session: sessionId,
            related: [],
            includeDirs: options.includeDirs,
            peerSelection: "none",
            retainExact: false,
            sha: undefined,
            role: "implemented",
          });
        }),
      );
      if (result._tag === "Failure") {
        const error = Option.getOrUndefined(Cause.findErrorOption(result.cause));
        failures.set(
          sessionId,
          error instanceof Error ? error.message : "local source, filtering, or upload failed",
        );
        yield* Console.log(`Could not backfill ${sessionId}: ${failures.get(sessionId)}`);
      }
    }
    const after = yield* call(api.history.codexInventory({ params, payload: {} }));
    let backfilled = 0;
    for (const artifact of legacy) {
      const filtered = after.artifacts.some(
        (a) =>
          a.copyKind === "filtered" &&
          a.sessionId === artifact.sessionId &&
          a.source === artifact.source &&
          a.sourceSha256 === artifact.version,
      );
      if (filtered) {
        backfilled++;
        continue;
      }
      yield* Console.log(
        `Not backfilled ${artifact.sessionId} (${artifact.source}, ${artifact.version.slice(0, 12)}): ${failures.get(artifact.sessionId) ?? "the available local source has a different version"}`,
      );
    }
    yield* Console.log(
      `Backfill: ${backfilled}/${legacy.length} legacy artifacts have matching filtered copies; ${legacy.length - backfilled} unavailable or failed.`,
    );
  },
  Effect.provide(Layer.mergeAll(FetchHttpClient.layer, ServerConfig.layer)),
);
