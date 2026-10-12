// Checkpoints in Postgres (TOOLREADER_DATABASE_URL): one JSON document per checkpoint, per
// workspace. A checkpoint's id is its key (core/checkpoint.ts `checkpointKey`), so writing the same
// moment again stores nothing new. Workspaces and their API tokens live here too: this is the only
// module that knows the tables (Migrations/).
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as SqlError from "effect/unstable/sql/SqlError";
import { PgClient } from "@effect/sql-pg/PgClient";

import { LIMITS } from "../../core/backendApi.ts";
import { Checkpoint, readCheckpoint } from "../../core/checkpoint.ts";

export class CheckpointStoreFailed extends Schema.TaggedErrorClass<CheckpointStoreFailed>()(
  "CheckpointStoreFailed",
  { message: Schema.String },
) {}

/**
 * `exists`: the same id was there with the same content. `differs`: it was there with other content
 * (other options, or history that changed since) and was kept; `replace` overwrites it.
 */
export type PutResult = "inserted" | "replaced" | "exists" | "differs";

/** Who writes: the workspace, the token (null: the CLI, straight to the database) and its version. */
export type Writer = {
  readonly workspaceId: string;
  readonly tokenId: string | null;
  readonly client: string;
};

/** A bearer token's owner, as `authenticate` finds it. */
export type Caller = {
  readonly tokenId: string;
  readonly workspaceId: string;
  readonly workspace: string;
};

const sha256 = (s: string) => NodeCrypto.createHash("sha256").update(s).digest("hex");

/** How `forCommit` found a checkpoint: its SHA, a recorded rewrite of it, or the same patch-id. */
export type CommitMatch = "sha" | "rewrite" | "patch-id";

const PayloadRow = Schema.Struct({ payload: Schema.Unknown });
const decodePayloadRows = Schema.decodeUnknownEffect(Schema.Array(PayloadRow));
const MatchRow = Schema.Struct({
  payload: Schema.Unknown,
  matched: Schema.Literals(["sha", "rewrite", "patch-id"]),
});
const decodeMatchRows = Schema.decodeUnknownEffect(Schema.Array(MatchRow));
const PutRow = Schema.Struct({ inserted: Schema.Boolean });
const decodePutRows = Schema.decodeUnknownEffect(Schema.Array(PutRow));
const ShaRow = Schema.Struct({ contentSha: Schema.String });
const decodeShaRows = Schema.decodeUnknownEffect(Schema.Array(ShaRow));
const IdRow = Schema.Struct({ id: Schema.String });
const decodeIdRows = Schema.decodeUnknownEffect(Schema.Array(IdRow));
const CallerRow = Schema.Struct({
  tokenId: Schema.String,
  workspaceId: Schema.String,
  workspace: Schema.String,
});
const decodeCallerRows = Schema.decodeUnknownEffect(Schema.Array(CallerRow));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Checkpoint));
/**
 * The JSON as jsonb takes it. jsonb refuses `\u0000` (binary output, some tool results) and lone
 * UTF-16 surrogates (text cut mid-emoji, as output clipping can); `JSON.stringify` writes both as
 * escapes and a valid pair as plain characters, so each such escape becomes U+FFFD. One after an
 * escaped backslash (an even run of them) is literal text, kept.
 */
const encodeCheckpoint = (checkpoint: Checkpoint) =>
  encodeJson(checkpoint).replace(/(?<!\\)((?:\\\\)*)\\u(?:0000|d[89a-f][0-9a-f]{2})/g, "$1\\ufffd");

/**
 * Postgres refused this record's data (SQLSTATE class 22, data exception; 23, integrity
 * constraint; 54, program limit, e.g. an id too long for its index): storing it again can't
 * succeed, unlike a `CheckpointStoreFailed`.
 */
export class CheckpointRefused extends Schema.TaggedErrorClass<CheckpointRefused>()(
  "CheckpointRefused",
  { message: Schema.String },
) {}

const isDataError = (e: SqlError.SqlError) =>
  e.cause._tag === "ConstraintError" ||
  e.cause._tag === "UniqueViolation" ||
  (e.cause._tag === "UnknownError" &&
    Predicate.hasProperty(e.cause.cause, "code") &&
    Predicate.isString(e.cause.cause.code) &&
    /^(?:22|54)/.test(e.cause.cause.code));

/** The SQL error, as `put` reports it; the message names no record text (Postgres' might). */
const putFailed = (e: { readonly _tag: string; readonly message: string }) =>
  e._tag === "SqlError" && isDataError(e as SqlError.SqlError)
    ? new CheckpointRefused({ message: "Postgres refused the record's data" })
    : failed(e);

const failed = (e: { readonly message: string }) =>
  new CheckpointStoreFailed({ message: e.message });

/** Stored payloads, decoded by `readCheckpoint`: one a newer toolreader wrote fails by name. */
const read = (payloads: ReadonlyArray<unknown>) =>
  Effect.forEach(payloads, (payload) =>
    Result.match(readCheckpoint(payload), {
      onSuccess: Effect.succeed,
      onFailure: (message) => Effect.fail(new CheckpointStoreFailed({ message })),
    }),
  );

/**
 * Each operation's bound. Interrupting a query cancels it on the server (`pg_cancel_backend`),
 * so this is a statement timeout that also works through a transaction-mode pooler, which
 * refuses `statement_timeout` as a startup parameter.
 */
const bounded = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () =>
        Effect.fail(
          new CheckpointStoreFailed({ message: "The checkpoint database took over 30s" }),
        ),
    }),
  );

/** One workspace's checkpoints: what `CheckpointStore.at` gives. */
export type WorkspaceStore = {
  readonly put: (
    checkpoint: Checkpoint,
    options?: { readonly replace?: boolean },
  ) => Effect.Effect<PutResult, CheckpointStoreFailed | CheckpointRefused>;
  readonly get: (id: string) => Effect.Effect<Option.Option<Checkpoint>, CheckpointStoreFailed>;
  /** By SHA, then through recorded rewrites (new → old, any number of them), then by patch-id. */
  readonly forCommit: (
    repo: string,
    sha: string,
    patchId: string | null,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly checkpoint: Checkpoint; readonly matched: CommitMatch }>,
    CheckpointStoreFailed
  >;
  /** A thread's checkpoints, oldest first: `limit` of them after the one `after` names. */
  readonly forThread: (
    threadId: string,
    page?: { readonly limit?: number; readonly after?: string },
  ) => Effect.Effect<ReadonlyArray<Checkpoint>, CheckpointStoreFailed>;
  /** Records git's old → new pairs after an amend or a rebase; returns how many were new. */
  readonly rewrite: (
    repo: string,
    pairs: ReadonlyArray<{ readonly oldSha: string; readonly newSha: string }>,
  ) => Effect.Effect<number, CheckpointStoreFailed>;
};

export class CheckpointStore extends Context.Service<
  CheckpointStore,
  {
    /** The workspace's checkpoints, written as `writer`. */
    readonly at: (writer: Writer) => WorkspaceStore;
    /** The workspace's id, creating it when it doesn't exist. */
    readonly workspace: (slug: string) => Effect.Effect<string, CheckpointStoreFailed>;
    /** A new token for the workspace (created if needed); only its SHA-256 is stored. */
    readonly createToken: (
      workspace: string,
      name: string,
    ) => Effect.Effect<string, CheckpointStoreFailed>;
    /** The live token's owner; marks it used. */
    readonly authenticate: (
      token: string,
    ) => Effect.Effect<Option.Option<Caller>, CheckpointStoreFailed>;
  }
>()("toolreader/server/backend/CheckpointStore") {
  static readonly layer = Layer.effect(
    CheckpointStore,
    Effect.gen(function* () {
      const sql = yield* PgClient;

      const put = Effect.fn("CheckpointStore.put")(
        function* (
          writer: Writer,
          checkpoint: Checkpoint,
          options: { readonly replace?: boolean } = {},
        ) {
          const payload = encodeCheckpoint(checkpoint);
          // Not content: when and by which version it was taken, the name the session was asked by,
          // and where the repo's HEAD and branch had moved since, nor the order labels came in.
          // A retake of the same history matches.
          const content = encodeCheckpoint({
            ...checkpoint,
            labels: Object.fromEntries(
              Object.entries(checkpoint.labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
            ),
            takenAt: "",
            toolreaderVersion: "",
            session: null,
            repo: { ...checkpoint.repo, branch: null, head: null },
          });
          const contentSha = sha256(content);
          const ws = writer.workspaceId;
          const values = sql`(${ws}, ${checkpoint.id}, ${payload}::jsonb, ${checkpoint.takenAt}, ${contentSha}, ${writer.tokenId}, ${writer.client})`;
          const columns = sql`(workspace_id, id, payload, taken_at, content_sha, uploaded_by, client)`;
          const rows = yield* (
            options.replace
              ? sql`
              INSERT INTO checkpoints ${columns} VALUES ${values}
              ON CONFLICT (workspace_id, id) DO UPDATE
                SET payload = excluded.payload, taken_at = excluded.taken_at,
                    content_sha = excluded.content_sha, uploaded_by = excluded.uploaded_by,
                    uploaded_at = now(), client = excluded.client
                WHERE checkpoints.content_sha <> excluded.content_sha
              RETURNING (xmax = 0) AS inserted`
              : sql`
              INSERT INTO checkpoints ${columns} VALUES ${values}
              ON CONFLICT (workspace_id, id) DO NOTHING
              RETURNING true AS inserted`
          ).pipe(Effect.flatMap(decodePutRows));
          const [row] = rows;
          if (row) return (row.inserted ? "inserted" : "replaced") as PutResult;
          const [stored] = yield* sql`
            SELECT content_sha AS "contentSha" FROM checkpoints
            WHERE workspace_id = ${ws} AND id = ${checkpoint.id}`.pipe(
            Effect.flatMap(decodeShaRows),
          );
          return (stored?.contentSha === contentSha ? "exists" : "differs") as PutResult;
        },
        Effect.mapError(putFailed),
        bounded,
      );

      const get = Effect.fn("CheckpointStore.get")(function* (ws: string, id: string) {
        const rows = yield* sql`
          SELECT payload FROM checkpoints WHERE workspace_id = ${ws} AND id = ${id}`.pipe(
          Effect.flatMap(decodePayloadRows),
          Effect.mapError(failed),
        );
        const [checkpoint] = yield* read(rows.map((r) => r.payload));
        return Option.fromNullishOr(checkpoint);
      }, bounded);

      const forCommit = Effect.fn("CheckpointStore.forCommit")(function* (
        ws: string,
        repo: string,
        sha: string,
        patchId: string | null,
      ) {
        // Every SHA this one was rewritten from (amend after amend, a rebase after that), up to 50
        // rewrites back; the depth limit stops cycles, and each SHA counts once, at its nearest.
        const rows = yield* sql`
          WITH RECURSIVE older (sha, depth) AS (
            SELECT old_sha, 1 FROM commit_rewrites
            WHERE workspace_id = ${ws} AND repo = ${repo} AND new_sha = ${sha}
            UNION
            SELECT r.old_sha, o.depth + 1 FROM commit_rewrites r
            JOIN older o ON r.new_sha = o.sha
            WHERE r.workspace_id = ${ws} AND r.repo = ${repo} AND o.depth < 50
          ), nearest AS (SELECT sha, min(depth) AS depth FROM older GROUP BY sha)
          SELECT payload, matched FROM (
            -- A checkpoint found two ways counts once, as the stronger, before the limit.
            SELECT DISTINCT ON (id) payload, matched, rank, depth, taken_at, id FROM (
            SELECT payload, 'sha' AS matched, 0 AS rank, 0 AS depth, taken_at, id FROM checkpoints
            WHERE workspace_id = ${ws} AND repo = ${repo} AND commit_sha = ${sha}
            UNION ALL
            SELECT c.payload, 'rewrite', 1, o.depth, c.taken_at, c.id FROM nearest o
            JOIN checkpoints c
              ON c.workspace_id = ${ws} AND c.repo = ${repo} AND c.commit_sha = o.sha
            UNION ALL
            SELECT payload, 'patch-id', 2, 0, taken_at, id FROM checkpoints
            WHERE ${patchId}::text IS NOT NULL AND workspace_id = ${ws} AND repo = ${repo}
              AND patch_id = ${patchId} AND commit_sha <> ${sha}
            ) found ORDER BY id, rank, depth
          ) best ORDER BY rank, depth, taken_at DESC, id LIMIT ${LIMITS.page}`.pipe(
          Effect.flatMap(decodeMatchRows),
          Effect.mapError(failed),
        );
        const checkpoints = yield* read(rows.map((r) => r.payload));
        return checkpoints.map((checkpoint, i) => ({ checkpoint, matched: rows[i]!.matched }));
      }, bounded);

      const forThread = Effect.fn("CheckpointStore.forThread")(function* (
        ws: string,
        threadId: string,
        page: { readonly limit?: number; readonly after?: string } = {},
      ) {
        // An `after` this workspace doesn't hold gives an empty page.
        const after = page.after ?? null;
        const rows = yield* sql`
          SELECT payload FROM checkpoints WHERE workspace_id = ${ws} AND thread_id = ${threadId}
            AND (${after}::text IS NULL OR (taken_at, id) > (
              SELECT taken_at, id FROM checkpoints WHERE workspace_id = ${ws} AND id = ${after}))
          ORDER BY taken_at, id LIMIT ${Math.min(page.limit ?? LIMITS.page, LIMITS.page)}`.pipe(
          Effect.flatMap(decodePayloadRows),
          Effect.mapError(failed),
        );
        return yield* read(rows.map((r) => r.payload));
      }, bounded);

      const rewrite = Effect.fn("CheckpointStore.rewrite")(function* (
        ws: string,
        repo: string,
        pairs: ReadonlyArray<{ readonly oldSha: string; readonly newSha: string }>,
      ) {
        // A commit "rewritten" to itself says nothing, and would loop the walk back.
        const moved = pairs.filter((p) => p.oldSha !== p.newSha);
        if (moved.length === 0) return 0;
        const rows = yield* sql`
          INSERT INTO commit_rewrites ${sql.insert(
            moved.map((p) => ({ workspace_id: ws, repo, old_sha: p.oldSha, new_sha: p.newSha })),
          )}
          ON CONFLICT DO NOTHING RETURNING old_sha`.pipe(Effect.mapError(failed));
        return rows.length;
      }, bounded);

      const workspace = Effect.fn("CheckpointStore.workspace")(function* (slug: string) {
        // The no-op update makes RETURNING give the row that was already there.
        const [row] = yield* sql`
          INSERT INTO workspaces (slug) VALUES (${slug})
          ON CONFLICT (slug) DO UPDATE SET slug = excluded.slug
          RETURNING id::text AS id`.pipe(Effect.flatMap(decodeIdRows), Effect.mapError(failed));
        return row!.id;
      }, bounded);

      const createToken = Effect.fn("CheckpointStore.createToken")(function* (
        slug: string,
        name: string,
      ) {
        const ws = yield* workspace(slug);
        const token = `trk_${NodeCrypto.randomBytes(32).toString("base64url")}`;
        yield* sql`
          INSERT INTO api_tokens (workspace_id, name, token_sha256)
          VALUES (${ws}, ${name}, ${sha256(token)})`.pipe(Effect.mapError(failed));
        return token;
      }, bounded);

      const authenticate = Effect.fn("CheckpointStore.authenticate")(function* (token: string) {
        // `last_used_at` is written at most once a minute: concurrent requests with one token
        // don't queue on its row.
        const [row] = yield* sql`
          WITH live AS (
            SELECT id, workspace_id, last_used_at FROM api_tokens
            WHERE token_sha256 = ${sha256(token)} AND revoked_at IS NULL
          ), touched AS (
            UPDATE api_tokens SET last_used_at = now()
            WHERE id IN (
              SELECT id FROM live
              WHERE last_used_at IS NULL OR last_used_at < now() - interval '1 minute'
            )
          )
          SELECT live.id::text AS "tokenId", w.id::text AS "workspaceId", w.slug AS workspace
          FROM live JOIN workspaces w ON w.id = live.workspace_id`.pipe(
          Effect.flatMap(decodeCallerRows),
          Effect.mapError(failed),
        );
        return Option.fromNullishOr(row);
      }, bounded);

      const at = (writer: Writer): WorkspaceStore => {
        const ws = writer.workspaceId;
        return {
          put: (checkpoint, options) => put(writer, checkpoint, options),
          get: (id) => get(ws, id),
          forCommit: (repo, sha, patchId) => forCommit(ws, repo, sha, patchId),
          forThread: (threadId, page) => forThread(ws, threadId, page),
          rewrite: (repo, pairs) => rewrite(ws, repo, pairs),
        };
      };

      return CheckpointStore.of({ at, workspace, createToken, authenticate });
    }),
  );
}
