// Checkpoints are JSON documents, kept per workspace (the team boundary; every key starts with
// `workspace_id`). The columns queries need are generated from the payload, so they can't drift
// from it. Timestamps aren't generated (a text cast isn't immutable): the store writes `taken_at`.
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
  // `uploaded_by` is null for what the CLI wrote straight to the database (`checkpoint put` and
  // `collect`, until they go through the backend).
  yield* sql`
    CREATE TABLE checkpoints (
      workspace_id  uuid NOT NULL REFERENCES workspaces(id),
      id            text NOT NULL,
      payload       jsonb NOT NULL,
      taken_at      timestamptz NOT NULL,
      content_sha   text NOT NULL,
      uploaded_by   uuid REFERENCES api_tokens(id),
      uploaded_at   timestamptz NOT NULL DEFAULT now(),
      client        text NOT NULL,
      trigger       text GENERATED ALWAYS AS (payload->>'trigger') STORED,
      thread_id     text GENERATED ALWAYS AS (payload->'thread'->>'id') STORED,
      session       text GENERATED ALWAYS AS (payload->>'session') STORED,
      repo          text GENERATED ALWAYS AS (payload->'repo'->>'name') STORED,
      commit_sha    text GENERATED ALWAYS AS (payload->'commit'->>'sha') STORED,
      patch_id      text GENERATED ALWAYS AS (payload->'commit'->>'patchId') STORED,
      PRIMARY KEY (workspace_id, id),
      CHECK ((trigger = 'commit') = (commit_sha IS NOT NULL))
    )`;
  yield* sql`CREATE INDEX checkpoints_commit ON checkpoints (workspace_id, repo, commit_sha) WHERE commit_sha IS NOT NULL`;
  yield* sql`CREATE INDEX checkpoints_patch ON checkpoints (workspace_id, repo, patch_id) WHERE patch_id IS NOT NULL`;
  yield* sql`CREATE INDEX checkpoints_thread ON checkpoints (workspace_id, thread_id, taken_at)`;
  yield* sql`CREATE INDEX checkpoints_session ON checkpoints (workspace_id, session) WHERE session IS NOT NULL`;
  // git's post-rewrite hook (amend, rebase): an exact old → new link, where patch-id only finds
  // rewrites that kept the diff.
  yield* sql`
    CREATE TABLE commit_rewrites (
      workspace_id  uuid NOT NULL REFERENCES workspaces(id),
      repo          text NOT NULL,
      old_sha       text NOT NULL,
      new_sha       text NOT NULL,
      rewritten_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, repo, new_sha, old_sha)
    )`;
});
