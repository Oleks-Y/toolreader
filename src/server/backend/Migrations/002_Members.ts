// Who may sign in to a workspace with GitHub: its pilot members, by GitHub login (lowercase).
// Membership lets someone in; GitHub's own answer decides which repos they can read.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE members (
      workspace_id  uuid NOT NULL REFERENCES workspaces(id),
      github_login  text NOT NULL,
      added_at      timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, github_login)
    )`;
});
