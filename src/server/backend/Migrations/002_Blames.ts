// Jev's answers for blamed hunks (core/blame.ts `StoredBlame`), one row per hunk and model: the
// webapp asks TypeSafe once per hunk, and every later reader of that line gets the stored answer.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE blames (
      workspace_id  uuid NOT NULL REFERENCES workspaces(id),
      repo          text NOT NULL,
      sha           text NOT NULL,
      hunk          text NOT NULL,
      model         text NOT NULL,
      payload       jsonb NOT NULL,
      created_at    timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, repo, sha, hunk, model)
    )`;
});
