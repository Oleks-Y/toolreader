// Project Insights' findings, per workspace and repo (core/insights.ts): what a detector found,
// where the people deciding on it took it (its lifecycle status), and every change of status with
// who made it, when and why. A detector run updates a finding's evidence, never its status, so a
// rejected finding isn't proposed again.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE findings (
      workspace_id  uuid NOT NULL REFERENCES workspaces(id),
      repo          text NOT NULL,
      key           text NOT NULL,
      id            text NOT NULL,
      detection     jsonb NOT NULL,
      status        text NOT NULL DEFAULT 'detected',
      events        jsonb NOT NULL DEFAULT '[]'::jsonb,
      detected_at   timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, repo, key),
      UNIQUE (workspace_id, repo, id)
    )`;
});
