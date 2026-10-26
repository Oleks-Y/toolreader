// What agents read with SQL (`POST /v1/workspaces/:ws/sql`, AgentSql.ts): the `agent_*` views over
// one workspace's conversations. Each workspace gets its own Postgres login (`agent_logins`,
// made by `HistoryStore.agentLogin`) granted SELECT on these views and nothing else. A view reads
// the tables with its owner's rights, but `current_user` inside it is still the caller's login, so
// the join on `agent_logins` keeps each login to its own workspace. There's no session setting
// to change and no role to switch to. `security_barrier` keeps a caller's WHERE from seeing rows
// before that join drops them.
//
// A later migration that adds one appends it to AGENT_VIEWS and grants it to every `agent_logins`
// role.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Everything an agent login may read. */
export const AGENT_VIEWS = ["agent_threads", "agent_entries"] as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The password is here so the backend can connect as the login; agents can't read this table.
  yield* sql`
    CREATE TABLE agent_logins (
      workspace_id  uuid PRIMARY KEY REFERENCES workspaces(id),
      role_name     text NOT NULL UNIQUE,
      password      text NOT NULL,
      created_at    timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`
    CREATE VIEW agent_threads WITH (security_barrier) AS
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
           jsonb_array_length(t.payload->'entries') AS entry_count
    FROM threads t
    JOIN agent_logins l ON l.workspace_id = t.workspace_id AND l.role_name = current_user::text`;
  // Numbers as int: node-postgres reads bigint and numeric as strings. `turn`: user messages so
  // far, so a turn's steps share its number. `kind` is an action's kind,
  // a message's role or an event's tone.
  yield* sql`
    CREATE VIEW agent_entries WITH (security_barrier) AS
    SELECT t.id AS thread_id,
           e.seq::int AS seq,
           (count(*) FILTER (WHERE e.v->>'role' = 'user')
             OVER (PARTITION BY t.id ORDER BY e.seq))::int AS turn,
           e.v->>'id' AS entry_id,
           e.v->>'at' AS at,
           e.v->>'type' AS type,
           coalesce(e.v->>'kind', e.v->>'role', e.v->>'tone') AS kind,
           e.v->>'status' AS status,
           e.v->>'title' AS title,
           e.v->>'hint' AS hint,
           e.v->>'command' AS command,
           (e.v->>'exitCode')::numeric::int AS exit_code,
           e.v->>'output' AS output,
           e.v->>'text' AS text,
           (SELECT jsonb_agg(f - 'addedKeys') FROM jsonb_array_elements(e.v->'files') f) AS files
    FROM threads t
    JOIN agent_logins l ON l.workspace_id = t.workspace_id AND l.role_name = current_user::text,
         jsonb_array_elements(t.payload->'entries') WITH ORDINALITY e(v, seq)`;
});
