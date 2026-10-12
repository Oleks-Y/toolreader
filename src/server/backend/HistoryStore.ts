// Agent history in Postgres (TOOLREADER_DATABASE_URL), per workspace: threads (each one's whole
// history, replaced when it grew) and commits (each one's links to those threads, replaced when
// it is linked again). Workspaces and their API tokens live here too: this is the only module
// that knows the tables (Migrations/).
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

import {
  CommitRecordV1,
  readCommit,
  readThread,
  ThreadRecordV1,
  type CommitRecord,
  type ThreadRecord,
} from "../../core/historyRecord.ts";
import { forJsonb, sha256, threadSha } from "../recordHash.ts";

export class HistoryStoreFailed extends Schema.TaggedErrorClass<HistoryStoreFailed>()(
  "HistoryStoreFailed",
  { message: Schema.String },
) {}

/**
 * Postgres refused a record's data (SQLSTATE class 22, data exception; 23, integrity constraint;
 * 54, program limit): storing it again can't succeed, unlike a `HistoryStoreFailed`.
 */
export class HistoryRefused extends Schema.TaggedErrorClass<HistoryRefused>()("HistoryRefused", {
  message: Schema.String,
}) {}

/** `same`: it was there with this content already. */
export type PutResult = "inserted" | "updated" | "same";

/** Who writes: the workspace, the token (null: tests and tools) and the client's version. */
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

const PayloadRow = Schema.Struct({ payload: Schema.Unknown });
const decodePayloadRows = Schema.decodeUnknownEffect(Schema.Array(PayloadRow));
const PutRow = Schema.Struct({ inserted: Schema.Boolean });
const decodePutRows = Schema.decodeUnknownEffect(Schema.Array(PutRow));
const HashRow = Schema.Struct({ id: Schema.String, contentSha: Schema.String });
const decodeHashRows = Schema.decodeUnknownEffect(Schema.Array(HashRow));
const IdRow = Schema.Struct({ id: Schema.String });
const decodeIdRows = Schema.decodeUnknownEffect(Schema.Array(IdRow));
const CallerRow = Schema.Struct({
  tokenId: Schema.String,
  workspaceId: Schema.String,
  workspace: Schema.String,
});
const decodeCallerRows = Schema.decodeUnknownEffect(Schema.Array(CallerRow));
const encodeThreadJson = Schema.encodeSync(Schema.fromJsonString(ThreadRecordV1));
const encodeCommitJson = Schema.encodeSync(Schema.fromJsonString(CommitRecordV1));

const commitSha = (record: CommitRecord) =>
  sha256(forJsonb(encodeCommitJson({ ...record, linkedAt: "", toolreaderVersion: "" })));

const isDataError = (e: SqlError.SqlError) =>
  e.cause._tag === "ConstraintError" ||
  e.cause._tag === "UniqueViolation" ||
  (e.cause._tag === "UnknownError" &&
    Predicate.hasProperty(e.cause.cause, "code") &&
    Predicate.isString(e.cause.cause.code) &&
    /^(?:22|54)/.test(e.cause.cause.code));

const failed = (e: { readonly message: string }) => new HistoryStoreFailed({ message: e.message });

/** The SQL error, as a put reports it; the message names no record text (Postgres' might). */
const putFailed = (e: { readonly _tag: string; readonly message: string }) =>
  e._tag === "SqlError" && isDataError(e as SqlError.SqlError)
    ? new HistoryRefused({ message: "Postgres refused the record's data" })
    : failed(e);

/** Stored payloads, decoded: one a newer toolreader wrote fails by name. */
const read = <A>(
  payloads: ReadonlyArray<unknown>,
  decode: (u: unknown) => Result.Result<A, string>,
) =>
  Effect.forEach(payloads, (payload) =>
    Result.match(decode(payload), {
      onSuccess: Effect.succeed,
      onFailure: (message) => Effect.fail(new HistoryStoreFailed({ message })),
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
      duration: "60 seconds",
      orElse: () =>
        Effect.fail(new HistoryStoreFailed({ message: "The history database took over 60s" })),
    }),
  );

/** One workspace's history: what `HistoryStore.at` gives. */
export type WorkspaceStore = {
  /** The stored content hash (`threadSha`) of each of `ids` this workspace holds. */
  readonly hashes: (
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, string>, HistoryStoreFailed>;
  readonly putThread: (
    record: ThreadRecord,
  ) => Effect.Effect<PutResult, HistoryStoreFailed | HistoryRefused>;
  readonly threads: (
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<ThreadRecord>, HistoryStoreFailed>;
  /** Replaces the commit's links: a commit linked again says everything about it again. */
  readonly putCommit: (
    record: CommitRecord,
  ) => Effect.Effect<PutResult, HistoryStoreFailed | HistoryRefused>;
  /** The commits of `shas` this workspace has links for, in no particular order. */
  readonly commits: (
    repo: string,
    shas: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<CommitRecord>, HistoryStoreFailed>;
};

export class HistoryStore extends Context.Service<
  HistoryStore,
  {
    /** The workspace's history, written as `writer`. */
    readonly at: (writer: Writer) => WorkspaceStore;
    /** The workspace's id, creating it when it doesn't exist. */
    readonly workspace: (slug: string) => Effect.Effect<string, HistoryStoreFailed>;
    /** A new token for the workspace (created if needed); only its SHA-256 is stored. */
    readonly createToken: (
      workspace: string,
      name: string,
    ) => Effect.Effect<string, HistoryStoreFailed>;
    /** The live token's owner; marks it used. */
    readonly authenticate: (
      token: string,
    ) => Effect.Effect<Option.Option<Caller>, HistoryStoreFailed>;
  }
>()("toolreader/server/backend/HistoryStore") {
  static readonly layer = Layer.effect(
    HistoryStore,
    Effect.gen(function* () {
      const sql = yield* PgClient;

      /** Inserts or replaces one row; `same` when the stored content is this content. */
      const upsert = (
        table: "threads" | "commits",
        key: Record<string, string>,
        payload: string,
        contentSha: string,
        writer: Writer,
      ) => {
        const row = {
          workspace_id: writer.workspaceId,
          ...key,
          payload,
          content_sha: contentSha,
          uploaded_by: writer.tokenId,
          client: writer.client,
        };
        const conflict =
          table === "threads" ? sql`(workspace_id, id)` : sql`(workspace_id, repo, sha)`;
        return sql`
          INSERT INTO ${sql(table)} ${sql.insert(row)}
          ON CONFLICT ${conflict} DO UPDATE
            SET payload = excluded.payload, content_sha = excluded.content_sha,
                uploaded_by = excluded.uploaded_by, uploaded_at = now(), client = excluded.client
            WHERE ${sql(table)}.content_sha <> excluded.content_sha
          RETURNING (xmax = 0) AS inserted`.pipe(
          Effect.flatMap(decodePutRows),
          Effect.map(([r]): PutResult => (r ? (r.inserted ? "inserted" : "updated") : "same")),
        );
      };

      const putThread = Effect.fn("HistoryStore.putThread")(
        function* (writer: Writer, record: ThreadRecord) {
          const payload = forJsonb(encodeThreadJson(record));
          return yield* upsert(
            "threads",
            { id: record.thread.id },
            payload,
            threadSha(record),
            writer,
          );
        },
        Effect.mapError(putFailed),
        bounded,
      );

      const putCommit = Effect.fn("HistoryStore.putCommit")(
        function* (writer: Writer, record: CommitRecord) {
          const payload = forJsonb(encodeCommitJson(record));
          return yield* upsert(
            "commits",
            { repo: record.repo, sha: record.sha },
            payload,
            commitSha(record),
            writer,
          );
        },
        Effect.mapError(putFailed),
        bounded,
      );

      const hashes = Effect.fn("HistoryStore.hashes")(function* (
        ws: string,
        ids: ReadonlyArray<string>,
      ) {
        if (ids.length === 0) return new Map<string, string>();
        const rows = yield* sql`
          SELECT id, content_sha AS "contentSha" FROM threads
          WHERE workspace_id = ${ws} AND id IN ${sql.in(ids)}`.pipe(
          Effect.flatMap(decodeHashRows),
          Effect.mapError(failed),
        );
        return new Map(rows.map((r) => [r.id, r.contentSha]));
      }, bounded);

      const threads = Effect.fn("HistoryStore.threads")(function* (
        ws: string,
        ids: ReadonlyArray<string>,
      ) {
        if (ids.length === 0) return [];
        const rows = yield* sql`
          SELECT payload FROM threads WHERE workspace_id = ${ws} AND id IN ${sql.in(ids)}`.pipe(
          Effect.flatMap(decodePayloadRows),
          Effect.mapError(failed),
        );
        return yield* read(
          rows.map((r) => r.payload),
          readThread,
        );
      }, bounded);

      const commits = Effect.fn("HistoryStore.commits")(function* (
        ws: string,
        repo: string,
        shas: ReadonlyArray<string>,
      ) {
        if (shas.length === 0) return [];
        const rows = yield* sql`
          SELECT payload FROM commits
          WHERE workspace_id = ${ws} AND repo = ${repo} AND sha IN ${sql.in(shas)}`.pipe(
          Effect.flatMap(decodePayloadRows),
          Effect.mapError(failed),
        );
        return yield* read(
          rows.map((r) => r.payload),
          readCommit,
        );
      }, bounded);

      const workspace = Effect.fn("HistoryStore.workspace")(function* (slug: string) {
        // The no-op update makes RETURNING give the row that was already there.
        const [row] = yield* sql`
          INSERT INTO workspaces (slug) VALUES (${slug})
          ON CONFLICT (slug) DO UPDATE SET slug = excluded.slug
          RETURNING id::text AS id`.pipe(Effect.flatMap(decodeIdRows), Effect.mapError(failed));
        return row!.id;
      }, bounded);

      const createToken = Effect.fn("HistoryStore.createToken")(function* (
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

      const authenticate = Effect.fn("HistoryStore.authenticate")(function* (token: string) {
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
          hashes: (ids) => hashes(ws, ids),
          putThread: (record) => putThread(writer, record),
          threads: (ids) => threads(ws, ids),
          putCommit: (record) => putCommit(writer, record),
          commits: (repo, shas) => commits(ws, repo, shas),
        };
      };

      return HistoryStore.of({ at, workspace, createToken, authenticate });
    }),
  );
}
