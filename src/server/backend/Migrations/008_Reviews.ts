// Frozen reviews (core/review.ts): one manifest per review, per repo.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE reviews (
      workspace_id  uuid NOT NULL REFERENCES workspaces(id),
      repo          text NOT NULL,
      id            text NOT NULL,
      manifest      jsonb NOT NULL,
      created_at    timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, repo, id)
    )`;
});
