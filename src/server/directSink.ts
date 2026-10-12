// Checkpoints without a backend: `checkpoint put` and `collect` write straight to Postgres at
// TOOLREADER_DATABASE_URL, in this process. With app.ts, the only module that joins the CLI side
// (checkpoints/) to the backend's store (backend/).
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import packageJson from "../../package.json" with { type: "json" };
import { CheckpointStore } from "./backend/CheckpointStore.ts";
import { CheckpointFailed, CheckpointSink, type SendResult } from "./checkpoints/Checkpoints.ts";

/**
 * The workspace `checkpoint put` and `collect` write to when they go straight to the database.
 * ponytail: one fixed workspace; goes away with the direct mode.
 */
export const DIRECT_WORKSPACE = "local";

/** Straight to the database at TOOLREADER_DATABASE_URL, into workspace `local`. */
export const DirectSink = Layer.effect(
  CheckpointSink,
  Effect.gen(function* () {
    const pg = yield* CheckpointStore;
    // Resolved on the first write: a command that writes nothing doesn't create a workspace.
    const store = yield* Effect.cached(
      Effect.map(pg.workspace(DIRECT_WORKSPACE), (workspaceId) =>
        pg.at({ workspaceId, tokenId: null, client: packageJson.version }),
      ),
    );
    const failed = Effect.mapError(
      (e: { readonly message: string }) => new CheckpointFailed({ message: e.message }),
    );
    return CheckpointSink.of({
      put: (checkpoint, options) =>
        Effect.flatMap(store, (s) => s.put(checkpoint, options)).pipe(
          Effect.map((result): SendResult => ({ result, detail: null })),
          // The database refused the record's data: retrying can't help, as with the backend's.
          Effect.catchTag("CheckpointRefused", (e) =>
            Effect.succeed<SendResult>({ result: "rejected", detail: e.message }),
          ),
          failed,
        ),
      rewrite: (repo, pairs) =>
        Effect.flatMap(store, (s) => s.rewrite(repo, pairs)).pipe(
          Effect.map((added): SendResult => ({ result: "inserted", detail: `${added} new` })),
          failed,
        ),
      flush: () => Effect.succeed({ sent: [], blocked: null, elsewhere: 0 }),
    });
  }),
);
