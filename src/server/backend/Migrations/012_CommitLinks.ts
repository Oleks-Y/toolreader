// What agents read about commits: `agent_commit_links`, one row per link a commit holds (which
// thread, in what role, by which turns or entries, where it ran), for the workspace's agent login
// only, as the other `agent_*` views (Migrations/009), and only links to threads the workspace
// still holds: a deleted thread's links go with it. Granted to every agent login made so far;
// later ones get it through AGENT_VIEWS.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE VIEW agent_commit_links WITH (security_barrier) AS
    SELECT c.repo,
           c.sha,
           c.payload->>'subject' AS subject,
           c.payload->>'committedAt' AS committed_at,
           k.l->>'threadId' AS thread_id,
           coalesce(k.l->>'role', 'implemented') AS role,
           k.l->>'via' AS via,
           k.l->'turns' AS turns,
           k.l->'entries' AS entries,
           k.l->>'version' AS version,
           k.l->>'environment' AS environment,
           k.l->>'testedSha' AS tested_sha,
           k.l->>'note' AS note,
           k.l->>'declaredBy' AS declared_by
    FROM commits c
    JOIN agent_logins g ON g.workspace_id = c.workspace_id AND g.role_name = current_user::text,
         jsonb_array_elements(c.payload->'links') k(l)
    WHERE EXISTS (SELECT 1 FROM threads t
                  WHERE t.workspace_id = c.workspace_id AND t.id = k.l->>'threadId')`;
  yield* sql`
    DO $$
    DECLARE r record;
    BEGIN
      FOR r IN SELECT role_name FROM agent_logins LOOP
        EXECUTE format('GRANT SELECT ON agent_commit_links TO %I', r.role_name);
      END LOOP;
    END $$`;
});
