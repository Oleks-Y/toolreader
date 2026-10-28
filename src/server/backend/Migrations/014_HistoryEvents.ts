// Complete private events, shared across rollout, hook and app-server artifacts.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const HISTORY_EVENT_VIEWS = ["agent_history_events"] as const;
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE codex_artifacts ADD COLUMN source text NOT NULL DEFAULT 'rollout'
    CHECK (source IN ('rollout','hook','app-server'))`;
  yield* sql`CREATE VIEW agent_history_events WITH (security_barrier) AS
    SELECT e.session_id::text AS session_id, e.sha256 AS version,
      a.source, e.seq, e.at AS timestamp, e.type AS event_type, e.raw AS data
    FROM codex_events e JOIN codex_artifacts a
      ON a.workspace_id=e.workspace_id AND a.session_id=e.session_id AND a.sha256=e.sha256
    JOIN agent_logins g ON g.workspace_id=e.workspace_id AND g.role_name=current_user::text`;
  yield* sql`CREATE OR REPLACE VIEW agent_codex_artifacts WITH (security_barrier) AS
    SELECT a.session_id, a.sha256 AS version, a.bytes, a.event_count, a.file_path, a.uploaded_at,
      s.root_id, a.source
    FROM codex_artifacts a JOIN agent_logins g
      ON g.workspace_id=a.workspace_id AND g.role_name=current_user::text
    JOIN codex_selections s ON s.workspace_id=a.workspace_id AND s.session_id=a.session_id AND s.sha256=a.sha256`;
  yield* sql`DO $$ DECLARE r record; BEGIN
    FOR r IN SELECT role_name FROM agent_logins LOOP
      EXECUTE format('GRANT SELECT ON agent_history_events TO %I',r.role_name);
    END LOOP; END $$`;
});
