// Screenshots agents looked at (MediaBucket.ts): whether a workspace keeps them (off until
// `backend media enable`), which it holds (`media`: the bucket's index, by content hash), and
// each entry's images by hash in `agent_entries`, which agents read the bytes of through `media`.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE workspaces ADD COLUMN media boolean NOT NULL DEFAULT false`;
  yield* sql`
    CREATE TABLE media (
      workspace_id  uuid NOT NULL REFERENCES workspaces(id),
      sha256        text NOT NULL,
      mime          text NOT NULL,
      bytes         integer NOT NULL,
      uploaded_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, sha256)
    )`;
  // As migration 9 made it, with `media` last: OR REPLACE keeps its grants.
  yield* sql`
    CREATE OR REPLACE VIEW agent_entries WITH (security_barrier) AS
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
           (SELECT jsonb_agg(f - 'addedKeys') FROM jsonb_array_elements(e.v->'files') f) AS files,
           e.v->'media' AS media
    FROM threads t
    JOIN agent_logins l ON l.workspace_id = t.workspace_id AND l.role_name = current_user::text,
         jsonb_array_elements(t.payload->'entries') WITH ORDINALITY e(v, seq)`;
});
