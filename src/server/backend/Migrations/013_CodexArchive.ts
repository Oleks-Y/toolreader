// Private pilot data bypasses publication redaction. Only workspace agent logins may read it.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const CODEX_VIEWS = [
  "agent_codex_artifacts",
  "agent_codex_events",
  "agent_codex_commit_links",
] as const;
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE codex_uploads (
    workspace_id uuid NOT NULL REFERENCES workspaces(id), id uuid NOT NULL,
    manifest jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(workspace_id, id))`;
  yield* sql`CREATE TABLE codex_upload_parts (
    workspace_id uuid NOT NULL, upload_id uuid NOT NULL, part integer NOT NULL,
    data bytea NOT NULL, PRIMARY KEY(workspace_id, upload_id, part),
    FOREIGN KEY(workspace_id, upload_id) REFERENCES codex_uploads(workspace_id,id) ON DELETE CASCADE)`;
  yield* sql`CREATE TABLE codex_artifacts (
    workspace_id uuid NOT NULL REFERENCES workspaces(id), session_id uuid NOT NULL,
    sha256 text NOT NULL, bytes bigint NOT NULL, event_count integer NOT NULL,
    file_path text NOT NULL, uploaded_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(workspace_id, session_id, sha256))`;
  yield* sql`CREATE TABLE codex_selections (
    workspace_id uuid NOT NULL, root_id uuid NOT NULL, session_id uuid NOT NULL,
    sha256 text NOT NULL, PRIMARY KEY(workspace_id,root_id,session_id,sha256),
    FOREIGN KEY(workspace_id,session_id,sha256) REFERENCES codex_artifacts ON DELETE CASCADE)`;
  yield* sql`CREATE TABLE codex_events (
    workspace_id uuid NOT NULL, session_id uuid NOT NULL, sha256 text NOT NULL,
    seq integer NOT NULL, type text NOT NULL, at text, raw jsonb NOT NULL,
    PRIMARY KEY(workspace_id,session_id,sha256,seq),
    FOREIGN KEY(workspace_id,session_id,sha256) REFERENCES codex_artifacts ON DELETE CASCADE)`;
  yield* sql`CREATE TABLE codex_commit_links (
    workspace_id uuid NOT NULL REFERENCES workspaces(id), repo text NOT NULL, sha text NOT NULL,
    session_id uuid NOT NULL, role text NOT NULL, linked_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(workspace_id,repo,sha,session_id,role))`;
  yield* sql`CREATE VIEW agent_codex_artifacts WITH (security_barrier) AS
    SELECT a.session_id, a.sha256 AS version, a.bytes, a.event_count, a.file_path, a.uploaded_at,
      s.root_id
    FROM codex_artifacts a JOIN agent_logins g
      ON g.workspace_id=a.workspace_id AND g.role_name=current_user::text
    JOIN codex_selections s ON s.workspace_id=a.workspace_id AND s.session_id=a.session_id AND s.sha256=a.sha256`;
  yield* sql`CREATE VIEW agent_codex_events WITH (security_barrier) AS
    SELECT e.session_id, e.sha256 AS version, e.seq, e.type, e.at, e.raw,
      e.raw->'payload' AS payload,
      e.raw->'payload'->>'call_id' AS call_id,
      e.raw->'payload'->>'name' AS tool_name,
      e.raw->'payload'->'arguments' AS tool_arguments,
      e.raw->'payload'->'input' AS tool_input,
      e.raw->'payload'->'output' AS tool_output
    FROM codex_events e JOIN agent_logins g
      ON g.workspace_id=e.workspace_id AND g.role_name=current_user::text`;
  yield* sql`CREATE VIEW agent_codex_commit_links WITH (security_barrier) AS
    SELECT c.repo,c.sha,c.session_id,c.role,c.linked_at
    FROM codex_commit_links c JOIN agent_logins g
      ON g.workspace_id=c.workspace_id AND g.role_name=current_user::text`;
  yield* sql`DO $$ DECLARE r record; BEGIN
    FOR r IN SELECT role_name FROM agent_logins LOOP
      EXECUTE format('GRANT SELECT ON agent_codex_artifacts,agent_codex_events,agent_codex_commit_links TO %I',r.role_name);
    END LOOP; END $$`;
});
