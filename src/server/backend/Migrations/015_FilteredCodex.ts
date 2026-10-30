// Mark legacy exact artifacts before any new filtered copy becomes agent-queryable.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const FILTERED_CODEX_VIEWS = ["agent_filtered_rollouts"] as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE codex_artifacts ADD COLUMN copy_kind text NOT NULL DEFAULT 'exact'
    CHECK (copy_kind IN ('exact','filtered'))`;
  yield* sql`ALTER TABLE codex_artifacts ADD COLUMN source_sha256 text`;
  yield* sql`ALTER TABLE codex_artifacts ADD COLUMN included_directories jsonb NOT NULL DEFAULT '[]'::jsonb`;
  yield* sql`CREATE OR REPLACE VIEW agent_codex_artifacts WITH (security_barrier) AS
    SELECT a.session_id, a.sha256 AS version, a.bytes, a.event_count,
      NULL::text AS file_path, a.uploaded_at,
      s.root_id, a.source, a.source_sha256, a.included_directories, a.copy_kind
    FROM codex_artifacts a JOIN agent_logins g
      ON g.workspace_id=a.workspace_id AND g.role_name=current_user::text
    JOIN codex_selections s ON s.workspace_id=a.workspace_id AND s.session_id=a.session_id AND s.sha256=a.sha256
    WHERE a.copy_kind='filtered'`;
  yield* sql`CREATE OR REPLACE VIEW agent_codex_events WITH (security_barrier) AS
    SELECT e.session_id, e.sha256 AS version, e.seq, e.type, e.at, e.raw,
      e.raw->'payload' AS payload,
      e.raw->'payload'->>'call_id' AS call_id,
      e.raw->'payload'->>'name' AS tool_name,
      e.raw->'payload'->'arguments' AS tool_arguments,
      e.raw->'payload'->'input' AS tool_input,
      e.raw->'payload'->'output' AS tool_output
    FROM codex_events e JOIN codex_artifacts a
      ON a.workspace_id=e.workspace_id AND a.session_id=e.session_id AND a.sha256=e.sha256
    JOIN agent_logins g ON g.workspace_id=e.workspace_id AND g.role_name=current_user::text
    WHERE a.copy_kind='filtered'`;
  yield* sql`CREATE OR REPLACE VIEW agent_history_events WITH (security_barrier) AS
    SELECT e.session_id::text AS session_id, e.sha256 AS version,
      a.source, e.seq, e.at AS timestamp, e.type AS event_type, e.raw AS data
    FROM codex_events e JOIN codex_artifacts a
      ON a.workspace_id=e.workspace_id AND a.session_id=e.session_id AND a.sha256=e.sha256
    JOIN agent_logins g ON g.workspace_id=e.workspace_id AND g.role_name=current_user::text
    WHERE a.copy_kind='filtered'`;
  yield* sql`CREATE VIEW agent_filtered_rollouts WITH (security_barrier) AS
    SELECT a.session_id::text AS session_id, a.sha256 AS version, a.source_sha256,
      a.source, a.bytes, a.event_count, a.included_directories, a.uploaded_at
    FROM codex_artifacts a JOIN agent_logins g
      ON g.workspace_id=a.workspace_id AND g.role_name=current_user::text
    WHERE a.copy_kind='filtered'`;
  yield* sql`DO $$ DECLARE r record; BEGIN
    FOR r IN SELECT role_name FROM agent_logins LOOP
      EXECUTE format('GRANT SELECT ON agent_filtered_rollouts TO %I',r.role_name);
    END LOOP; END $$`;
});
