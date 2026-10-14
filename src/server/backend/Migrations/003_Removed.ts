// Threads removed from the history: deleted on request, or expired past the retention period.
// What stays is a marker (which thread, which version, why, when), so a citation of it reads
// `deleted` or `expired` instead of nothing, and a deleted thread isn't stored again by the next
// sync. The thread's body, its search hits and the findings' citations of it go.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE removed (
      workspace_id  uuid NOT NULL REFERENCES workspaces(id),
      thread_id     text NOT NULL,
      version       text NOT NULL,
      reason        text NOT NULL CHECK (reason IN ('deleted', 'expired')),
      removed_at    timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, thread_id)
    )`;
});
