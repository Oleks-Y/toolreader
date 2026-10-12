// Agent history, per workspace (the team boundary; every key starts with `workspace_id`): each
// thread's whole history once, and each commit's links to the threads that wrote it. Links are
// replaced whenever a commit is linked again (after a split, rebase or a later push), threads
// whenever they grew.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE workspaces (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slug        text NOT NULL UNIQUE,
      created_at  timestamptz NOT NULL DEFAULT now()
    )`;
  // The token itself is never stored: a request's bearer token is found by its SHA-256.
  yield* sql`
    CREATE TABLE api_tokens (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id  uuid NOT NULL REFERENCES workspaces(id),
      name          text NOT NULL,
      token_sha256  text NOT NULL UNIQUE,
      created_at    timestamptz NOT NULL DEFAULT now(),
      last_used_at  timestamptz,
      revoked_at    timestamptz
    )`;
  yield* sql`
    CREATE TABLE threads (
      workspace_id  uuid NOT NULL REFERENCES workspaces(id),
      id            text NOT NULL,
      payload       jsonb NOT NULL,
      content_sha   text NOT NULL,
      uploaded_by   uuid REFERENCES api_tokens(id),
      uploaded_at   timestamptz NOT NULL DEFAULT now(),
      client        text NOT NULL,
      PRIMARY KEY (workspace_id, id)
    )`;
  yield* sql`
    CREATE TABLE commits (
      workspace_id  uuid NOT NULL REFERENCES workspaces(id),
      repo          text NOT NULL,
      sha           text NOT NULL,
      payload       jsonb NOT NULL,
      content_sha   text NOT NULL,
      uploaded_by   uuid REFERENCES api_tokens(id),
      uploaded_at   timestamptz NOT NULL DEFAULT now(),
      client        text NOT NULL,
      PRIMARY KEY (workspace_id, repo, sha)
    )`;
});
