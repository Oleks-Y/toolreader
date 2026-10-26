// How current each stored thread is: `checked_at`, when a client last sent it or confirmed the
// stored copy still matches its source (every accepted put, `same` included, and `checked`), and
// `source_state`, what that source said of it then. `agent_threads` shows both, and the newest
// entry's time, so an agent can say "as of" instead of "never".
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE threads ADD COLUMN checked_at timestamptz, ADD COLUMN source_state text`;
  // Until a client says otherwise, a copy was last confirmed when it was stored.
  yield* sql`UPDATE threads SET checked_at = uploaded_at`;
  yield* sql`ALTER TABLE threads ALTER COLUMN checked_at SET DEFAULT now()`;
  // As migration 9 made it, the new columns last: OR REPLACE keeps its grants. Records from
  // clients before `lastEntryAt` get it from their entries.
  yield* sql`
    CREATE OR REPLACE VIEW agent_threads WITH (security_barrier) AS
    SELECT t.id,
           t.payload->'thread'->>'title' AS title,
           t.payload->'thread'->>'source' AS source,
           t.payload->'thread'->>'provider' AS provider,
           t.payload->'thread'->>'origin' AS origin,
           t.payload->'thread'->>'parent' AS parent,
           t.payload->'snapshot' AS snapshot,
           t.payload->>'takenAt' AS taken_at,
           t.uploaded_at,
           t.content_sha AS version,
           jsonb_array_length(t.payload->'entries') AS entry_count,
           coalesce(t.payload->>'lastEntryAt',
                    (SELECT max(e->>'at') FROM jsonb_array_elements(t.payload->'entries') e))
             AS last_entry_at,
           coalesce(t.source_state, 'unknown') AS source_state,
           t.checked_at
    FROM threads t
    JOIN agent_logins l ON l.workspace_id = t.workspace_id AND l.role_name = current_user::text`;
});
