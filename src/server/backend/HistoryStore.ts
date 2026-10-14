// Agent history in Postgres (TOOLREADER_DATABASE_URL), per workspace: threads (each one's whole
// history, replaced when it grew) and commits (each one's links to those threads, replaced when
// it is linked again). Workspaces and their API tokens live here too: this is the only module
// that knows the tables (Migrations/).
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as SqlError from "effect/unstable/sql/SqlError";
import type { Fragment as SqlFragment } from "effect/unstable/sql/Statement";
import { PgClient } from "@effect/sql-pg/PgClient";

import {
  CommitRecordV1,
  readCommit,
  readThread,
  ThreadRecordV1,
  type CommitRecord,
  type ThreadRecord,
} from "../../core/historyRecord.ts";
import { Entry } from "../../core/domain.ts";
import type { Evidence, SearchHit } from "../../core/historyApi.ts";
import {
  Detection,
  Finding,
  FindingEvent,
  FINDING_STATUSES,
  transitionError,
  type FindingStatus,
} from "../../core/insights.ts";
import { CHECKS_METHOD } from "../../core/checks.ts";
import { DETECTORS } from "../../core/insights.ts";
import { ReviewManifest, type EvidenceNow } from "../../core/review.ts";
import { forJsonb, sha256, threadSha } from "../recordHash.ts";
import { ENTRY_ROWS } from "./Migrations/005_Entries.ts";

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

/** No finding by that id in the repo. */
export class FindingMissing extends Schema.TaggedErrorClass<FindingMissing>()("FindingMissing", {
  message: Schema.String,
}) {}

/** A status change the lifecycle doesn't allow. */
export class FindingConflict extends Schema.TaggedErrorClass<FindingConflict>()("FindingConflict", {
  message: Schema.String,
}) {}

/** `same`: it was there with this content already. */
export type PutResult = "inserted" | "updated" | "same";

/** Who writes: the workspace, the token (null: tests, tools, GitHub sign-ins) and the client's version. */
export type Writer = {
  readonly workspaceId: string;
  readonly tokenId: string | null;
  readonly client: string;
  /** Who decides on findings, when not a token: `github:<login>`. */
  readonly actor?: string | undefined;
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
const opt = Schema.optional(Schema.NullOr(Schema.String));
const SearchRow = Schema.Struct({
  threadId: Schema.String,
  threadTitle: opt,
  version: Schema.String,
  entryId: Schema.String,
  at: opt,
  type: Schema.Literals(["action", "message"]),
  kind: opt,
  status: opt,
  title: opt,
  search: Schema.String,
});
const decodeSearchRows = Schema.decodeUnknownEffect(Schema.Array(SearchRow));
const RemovedRow = Schema.Struct({
  version: Schema.String,
  reason: Schema.Literals(["deleted", "expired"]),
});
const decodeRemovedRows = Schema.decodeUnknownEffect(Schema.Array(RemovedRow));
const EvidenceRow = Schema.Struct({
  version: Schema.String,
  linked: Schema.Boolean,
  entry: Schema.NullOr(Schema.Unknown),
});
const decodeEvidenceRows = Schema.decodeUnknownEffect(Schema.Array(EvidenceRow));
const decodeEntry = Schema.decodeUnknownOption(Entry);
const CountRow = Schema.Struct({ n: Schema.Number });
const decodeCountRows = Schema.decodeUnknownEffect(Schema.Array(CountRow));
const VersionRow = Schema.Struct({ id: Schema.String, version: Schema.String });
const decodeVersionRows = Schema.decodeUnknownEffect(Schema.Array(VersionRow));
const ManifestRow = Schema.Struct({ manifest: ReviewManifest });
const decodeManifestRows = Schema.decodeUnknownEffect(Schema.Array(ManifestRow));
const encodeManifestJson = Schema.encodeSync(Schema.fromJsonString(ReviewManifest));
const RemovedReasonRow = Schema.Struct({
  id: Schema.String,
  reason: Schema.Literals(["deleted", "expired"]),
});
const decodeRemovedReasonRows = Schema.decodeUnknownEffect(Schema.Array(RemovedReasonRow));
const FindingRow = Schema.Struct({
  id: Schema.String,
  detection: Detection,
  status: Schema.Literals(FINDING_STATUSES),
  events: Schema.Array(FindingEvent),
  detectedAt: Schema.String,
  updatedAt: Schema.String,
});
const decodeFindingRows = Schema.decodeUnknownEffect(Schema.Array(FindingRow));
const StatusRow = Schema.Struct({ status: Schema.Literals(FINDING_STATUSES) });
const decodeStatusRows = Schema.decodeUnknownEffect(Schema.Array(StatusRow));
const encodeDetectionJson = Schema.encodeSync(Schema.fromJsonString(Detection));
const encodeEventJson = Schema.encodeSync(Schema.fromJsonString(FindingEvent));

const findingOf = (r: typeof FindingRow.Type): Finding => ({
  ...r.detection,
  id: r.id,
  status: r.status,
  events: r.events,
  detectedAt: r.detectedAt,
  updatedAt: r.updatedAt,
});
/** A finding's short id: stable, since its key is. */
const findingId = (key: string) => sha256(key).slice(0, 10);

/** `text` as an ILIKE pattern that matches it literally anywhere. */
const containing = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** The first field holding `text`, cut to a window around it. */
const snippetOf = (fields: ReadonlyArray<string | null | undefined>, text: string) => {
  const needle = text.toLowerCase();
  for (const f of fields) {
    const at = f?.toLowerCase().indexOf(needle) ?? -1;
    if (f && at >= 0) {
      const from = Math.max(0, at - 60);
      const to = Math.min(f.length, at + text.length + 60);
      return `${from > 0 ? "…" : ""}${f.slice(from, to).replace(/\s+/g, " ")}${to < f.length ? "…" : ""}`;
    }
  }
  return "";
};
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
  /** With `repo`, only those linked to its commits. */
  readonly threads: (
    ids: ReadonlyArray<string>,
    repo?: string | undefined,
  ) => Effect.Effect<ReadonlyArray<ThreadRecord>, HistoryStoreFailed>;
  /** Replaces the commit's links: a commit linked again says everything about it again. */
  readonly putCommit: (
    record: CommitRecord,
  ) => Effect.Effect<PutResult, HistoryStoreFailed | HistoryRefused>;
  /** Entries holding `text`, newest first; `repo` keeps threads linked to its commits. */
  readonly search: (query: {
    readonly text: string;
    readonly repo?: string | undefined;
    readonly limit: number;
  }) => Effect.Effect<
    { readonly hits: ReadonlyArray<SearchHit>; readonly truncated: boolean },
    HistoryStoreFailed
  >;
  /** A citation read back, or why not (`Evidence`); `repo` keeps it to threads linked there. */
  readonly evidence: (cite: {
    readonly threadId: string;
    readonly entryId: string;
    readonly version?: string | undefined;
    readonly repo?: string | undefined;
  }) => Effect.Effect<Evidence, HistoryStoreFailed>;
  /** Every thread linked to the repo's commits: what the Insights detectors read. */
  readonly repoThreads: (
    repo: string,
  ) => Effect.Effect<ReadonlyArray<ThreadRecord>, HistoryStoreFailed>;
  /** Keeps detections: new ones as `detected`, known ones with their evidence replaced. */
  readonly putDetections: (
    repo: string,
    detections: ReadonlyArray<Detection>,
  ) => Effect.Effect<{ readonly found: number; readonly added: number }, HistoryStoreFailed>;
  readonly findings: (
    repo: string,
    statuses?: ReadonlyArray<FindingStatus>,
  ) => Effect.Effect<ReadonlyArray<Finding>, HistoryStoreFailed>;
  /** Moves a finding along its lifecycle, as this writer's token, with why. */
  readonly transition: (
    repo: string,
    id: string,
    to: FindingStatus,
    why: string,
  ) => Effect.Effect<Finding, HistoryStoreFailed | FindingMissing | FindingConflict>;
  /** Freezes a review of `shas` (core/review.ts) as this writer; the manifest stored. */
  readonly freezeReview: (input: {
    readonly repo: string;
    readonly range: string;
    readonly shas: ReadonlyArray<string>;
    readonly verdict: ReviewManifest["decision"]["verdict"];
    readonly note: string;
    readonly server: string;
  }) => Effect.Effect<ReviewManifest, HistoryStoreFailed>;
  /** A frozen review, as it was, with what each cited session is now. */
  readonly review: (
    repo: string,
    id: string,
  ) => Effect.Effect<
    Option.Option<{
      readonly manifest: ReviewManifest;
      readonly now: ReadonlyArray<{ readonly threadId: string; readonly status: EvidenceNow }>;
    }>,
    HistoryStoreFailed
  >;
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
    /** Lets a GitHub login sign in to the workspace (created if needed). */
    readonly addMember: (
      workspace: string,
      login: string,
    ) => Effect.Effect<void, HistoryStoreFailed>;
    /** Stops a GitHub login signing in to the workspace; whether it was a member. */
    readonly removeMember: (
      workspace: string,
      login: string,
    ) => Effect.Effect<boolean, HistoryStoreFailed>;
    /** The workspace, when the GitHub login is one of its members. */
    readonly member: (
      workspace: string,
      login: string,
    ) => Effect.Effect<Option.Option<{ readonly workspaceId: string }>, HistoryStoreFailed>;
    /** Removes a thread on request: its body, search hits and findings' citations; a marker stays. */
    readonly deleteThread: (
      workspace: string,
      id: string,
    ) => Effect.Effect<boolean, HistoryStoreFailed>;
    /** Removes every thread stored more than `days` ago, in every workspace; how many went. */
    readonly expire: (days: number) => Effect.Effect<number, HistoryStoreFailed>;
    /** Revokes the workspace's tokens by that name; how many. */
    readonly revokeToken: (
      workspace: string,
      name: string,
    ) => Effect.Effect<number, HistoryStoreFailed>;
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
          // Deleted on request: never stored again. Expired: not this version again.
          const [gone] = yield* sql`
            SELECT version, reason FROM removed
            WHERE workspace_id = ${writer.workspaceId} AND thread_id = ${record.thread.id}`.pipe(
            Effect.flatMap(decodeRemovedRows),
          );
          if (gone && (gone.reason === "deleted" || gone.version === threadSha(record)))
            return "same" as const;
          if (gone)
            yield* sql`
              DELETE FROM removed
              WHERE workspace_id = ${writer.workspaceId} AND thread_id = ${record.thread.id}`;
          const payload = forJsonb(encodeThreadJson(record));
          const result = yield* upsert(
            "threads",
            { id: record.thread.id },
            payload,
            threadSha(record),
            writer,
          );
          // Search's rows follow the thread, in the same transaction.
          if (result !== "same") {
            yield* sql`
              DELETE FROM entries
              WHERE workspace_id = ${writer.workspaceId} AND thread_id = ${record.thread.id}`;
            yield* sql.unsafe(
              `INSERT INTO entries (workspace_id, thread_id, entry_id, at, type, kind, status, title,
                                    thread_title, search)
               ${ENTRY_ROWS} WHERE t.workspace_id = $1 AND t.id = $2
               ON CONFLICT DO NOTHING`,
              [writer.workspaceId, record.thread.id],
            );
          }
          return result;
        },
        (self) => sql.withTransaction(self),
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
        repo?: string | undefined,
      ) {
        if (ids.length === 0) return [];
        const inRepo = repo ? sql`AND id IN (${linkedTo(ws, repo)})` : sql``;
        const rows = yield* sql`
          SELECT payload FROM threads
          WHERE workspace_id = ${ws} AND id IN ${sql.in(ids)} ${inRepo}`.pipe(
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

      // Over `entries` (migration 5): matching rows only, through the trigram index.
      const search = Effect.fn("HistoryStore.search")(function* (
        ws: string,
        query: {
          readonly text: string;
          readonly repo?: string | undefined;
          readonly limit: number;
        },
      ) {
        const p = containing(query.text);
        const inRepo = query.repo ? sql`AND n.thread_id IN (${linkedTo(ws, query.repo)})` : sql``;
        const rows = yield* sql`
          SELECT n.thread_id AS "threadId", n.thread_title AS "threadTitle",
                 t.content_sha AS version, n.entry_id AS "entryId", n.at, n.type, n.kind,
                 n.status, n.title, n.search
          FROM entries n
          JOIN threads t ON t.workspace_id = n.workspace_id AND t.id = n.thread_id
          WHERE n.workspace_id = ${ws} AND n.search ILIKE ${p} ${inRepo}
          ORDER BY n.at DESC NULLS LAST
          LIMIT ${query.limit + 1}`.pipe(Effect.flatMap(decodeSearchRows), Effect.mapError(failed));
        const hits = rows.slice(0, query.limit).map((r) => ({
          threadId: r.threadId,
          threadTitle: r.threadTitle ?? "",
          version: r.version,
          entryId: r.entryId,
          at: r.at ?? "",
          type: r.type,
          kind: r.kind ?? "",
          ...(r.status ? { status: r.status } : {}),
          title: r.title ?? "",
          snippet: snippetOf(r.search.split("\u001f"), query.text),
        }));
        return { hits, truncated: rows.length > query.limit };
      }, bounded);

      const linkedTo = (ws: string, repo: string) => sql`
        SELECT DISTINCT l->>'threadId' FROM commits c, jsonb_array_elements(c.payload->'links') l
        WHERE c.workspace_id = ${ws} AND c.repo = ${repo}`;

      // ponytail: every linked thread, whole, in one query; page it when a repo's history
      // outgrows the backend's memory.
      const repoThreads = Effect.fn("HistoryStore.repoThreads")(function* (
        ws: string,
        repo: string,
      ) {
        const rows = yield* sql`
          SELECT payload FROM threads
          WHERE workspace_id = ${ws} AND id IN (${linkedTo(ws, repo)})`.pipe(
          Effect.flatMap(decodePayloadRows),
          Effect.mapError(failed),
        );
        return yield* read(
          rows.map((r) => r.payload),
          readThread,
        );
      }, bounded);

      const putDetections = Effect.fn("HistoryStore.putDetections")(function* (
        ws: string,
        repo: string,
        detections: ReadonlyArray<Detection>,
      ) {
        let added = 0;
        for (const d of detections) {
          const [row] = yield* sql`
            INSERT INTO findings (workspace_id, repo, key, id, detection)
            VALUES (${ws}, ${repo}, ${d.key}, ${findingId(d.key)},
                    ${forJsonb(encodeDetectionJson(d))}::jsonb)
            ON CONFLICT (workspace_id, repo, key) DO UPDATE
              SET detection = excluded.detection, updated_at = now()
            RETURNING (xmax = 0) AS inserted`.pipe(
            Effect.flatMap(decodePutRows),
            Effect.mapError(failed),
          );
          if (row?.inserted) added++;
        }
        return { found: detections.length, added };
      }, bounded);

      const findingColumns = sql`
        id, detection, status, events,
        to_char(detected_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "detectedAt",
        to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "updatedAt"`;

      const findings = Effect.fn("HistoryStore.findings")(function* (
        ws: string,
        repo: string,
        statuses?: ReadonlyArray<FindingStatus>,
      ) {
        const only = statuses?.length ? sql`AND status IN ${sql.in(statuses)}` : sql``;
        const rows = yield* sql`
          SELECT ${findingColumns} FROM findings
          WHERE workspace_id = ${ws} AND repo = ${repo} ${only}
          ORDER BY (detection->>'sessions')::int DESC, key`.pipe(
          Effect.flatMap(decodeFindingRows),
          Effect.mapError(failed),
        );
        return rows.map(findingOf);
      }, bounded);

      const transition = Effect.fn("HistoryStore.transition")(
        function* (writer: Writer, repo: string, id: string, to: FindingStatus, why: string) {
          const ws = writer.workspaceId;
          const [current] = yield* sql`
            SELECT status FROM findings
            WHERE workspace_id = ${ws} AND repo = ${repo} AND id = ${id} FOR UPDATE`.pipe(
            Effect.flatMap(decodeStatusRows),
            Effect.mapError(failed),
          );
          if (!current)
            return yield* new FindingMissing({ message: `No finding ${id} in ${repo}` });
          const problem = transitionError(current.status, to);
          if (problem) return yield* new FindingConflict({ message: problem });
          const [by] = writer.actor
            ? [{ id: writer.actor }]
            : writer.tokenId
              ? yield* sql`SELECT name AS id FROM api_tokens WHERE id = ${writer.tokenId}`.pipe(
                  Effect.flatMap(decodeIdRows),
                  Effect.mapError(failed),
                )
              : [];
          const event = encodeEventJson({
            from: current.status,
            to,
            by: by?.id ?? "unknown",
            at: DateTime.formatIso(yield* DateTime.now),
            why,
          });
          const [row] = yield* sql`
            UPDATE findings
            SET status = ${to}, events = events || jsonb_build_array(${event}::jsonb),
                updated_at = now()
            WHERE workspace_id = ${ws} AND repo = ${repo} AND id = ${id}
            RETURNING ${findingColumns}`.pipe(
            Effect.flatMap(decodeFindingRows),
            Effect.mapError(failed),
          );
          return findingOf(row!);
        },
        (self) =>
          sql
            .withTransaction(self)
            .pipe(Effect.catchTag("SqlError", (e) => Effect.fail(failed(e)))),
        bounded,
      );

      const evidence = Effect.fn("HistoryStore.evidence")(function* (
        ws: string,
        cite: {
          readonly threadId: string;
          readonly entryId: string;
          readonly version?: string | undefined;
          readonly repo?: string | undefined;
        },
      ) {
        const [gone] = yield* sql`
          SELECT version, reason FROM removed
          WHERE workspace_id = ${ws} AND thread_id = ${cite.threadId}`.pipe(
          Effect.flatMap(decodeRemovedRows),
          Effect.mapError(failed),
        );
        if (gone) return { status: gone.reason } satisfies Evidence;
        const linked = cite.repo ? sql`t.id IN (${linkedTo(ws, cite.repo)})` : sql`true`;
        const [row] = yield* sql`
          SELECT t.content_sha AS version, ${linked} AS linked,
                 (SELECT e FROM jsonb_array_elements(t.payload->'entries') e
                  WHERE e->>'id' = ${cite.entryId} LIMIT 1) AS entry
          FROM threads t WHERE t.workspace_id = ${ws} AND t.id = ${cite.threadId}`.pipe(
          Effect.flatMap(decodeEvidenceRows),
          Effect.mapError(failed),
        );
        if (!row) return { status: "missing" } satisfies Evidence;
        if (!row.linked) return { status: "withheld" } satisfies Evidence;
        if (cite.version && !row.version.startsWith(cite.version))
          return { status: "version-unavailable", version: row.version } satisfies Evidence;
        const entry = Option.getOrUndefined(decodeEntry(row.entry));
        return entry
          ? ({ status: "ok", entry, version: row.version } satisfies Evidence)
          : ({ status: "missing", version: row.version } satisfies Evidence);
      }, bounded);

      /**
       * Removes threads (`ids`, or every one stored before `before`) from a workspace, or from all
       * of them: bodies, and the findings' citations of them; a marker per thread stays.
       */
      const remove = (reason: "deleted" | "expired", where: SqlFragment) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const gone = yield* sql`
              WITH gone AS (DELETE FROM threads WHERE ${where} RETURNING workspace_id, id, content_sha),
              marked AS (
                INSERT INTO removed (workspace_id, thread_id, version, reason)
                SELECT workspace_id, id, content_sha, ${reason} FROM gone
                ON CONFLICT (workspace_id, thread_id) DO UPDATE
                  SET version = excluded.version, reason = excluded.reason, removed_at = now()
              ),
              cited AS (
                UPDATE findings f SET detection = jsonb_set(f.detection, '{occurrences}', coalesce((
                  SELECT jsonb_agg(o) FROM jsonb_array_elements(f.detection->'occurrences') o
                  WHERE NOT EXISTS (SELECT 1 FROM gone g
                                    WHERE g.workspace_id = f.workspace_id AND g.id = o->>'threadId')
                ), '[]'::jsonb)), updated_at = now()
                WHERE EXISTS (SELECT 1 FROM gone g, jsonb_array_elements(f.detection->'occurrences') o
                              WHERE g.workspace_id = f.workspace_id AND g.id = o->>'threadId')
              ),
              -- Frozen reviews keep no conclusions drawn from a removed session, and say so.
              reviewed AS (
                UPDATE reviews r SET manifest = jsonb_set(jsonb_set(r.manifest, '{commits}', coalesce((
                  SELECT jsonb_agg(jsonb_set(c, '{links}', coalesce((
                    SELECT jsonb_agg(l) FROM jsonb_array_elements(c->'links') l
                    WHERE NOT EXISTS (SELECT 1 FROM gone g
                                      WHERE g.workspace_id = r.workspace_id AND g.id = l->>'threadId')
                  ), '[]'::jsonb)))
                  FROM jsonb_array_elements(r.manifest->'commits') c), '[]'::jsonb)),
                  '{removed}', coalesce(r.manifest->'removed', '[]'::jsonb) || coalesce((
                    SELECT jsonb_agg(g.id) FROM gone g
                    WHERE g.workspace_id = r.workspace_id
                      AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.manifest->'evidence') ev
                                  WHERE ev->>'threadId' = g.id)), '[]'::jsonb))
                WHERE EXISTS (SELECT 1 FROM gone g, jsonb_array_elements(r.manifest->'evidence') ev
                              WHERE g.workspace_id = r.workspace_id AND ev->>'threadId' = g.id)
              )
              SELECT count(*)::int AS n FROM gone`.pipe(Effect.flatMap(decodeCountRows));
              return gone[0]?.n ?? 0;
            }),
          )
          .pipe(Effect.mapError(failed), bounded);

      const freezeReview = Effect.fn("HistoryStore.freezeReview")(function* (
        writer: Writer,
        input: {
          readonly repo: string;
          readonly range: string;
          readonly shas: ReadonlyArray<string>;
          readonly verdict: ReviewManifest["decision"]["verdict"];
          readonly note: string;
          readonly server: string;
        },
      ) {
        const ws = writer.workspaceId;
        const records = yield* commits(ws, input.repo, input.shas);
        const ids = [...new Set(records.flatMap((c) => c.links.map((l) => l.threadId)))];
        const versions =
          ids.length === 0
            ? []
            : yield* sql`
                SELECT id, content_sha AS version FROM threads
                WHERE workspace_id = ${ws} AND id IN ${sql.in(ids)}`.pipe(
                Effect.flatMap(decodeVersionRows),
                Effect.mapError(failed),
              );
        const open = yield* findings(ws, input.repo);
        const [by] = writer.actor
          ? [{ id: writer.actor }]
          : writer.tokenId
            ? yield* sql`SELECT name AS id FROM api_tokens WHERE id = ${writer.tokenId}`.pipe(
                Effect.flatMap(decodeIdRows),
                Effect.mapError(failed),
              )
            : [];
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const order = new Map(input.shas.map((s, i) => [s, i]));
        const manifest: ReviewManifest = {
          manifestVersion: 1,
          id: sha256(`${input.repo}\u0000${input.range}\u0000${createdAt}`).slice(0, 10),
          repo: input.repo,
          range: input.range,
          shas: [...input.shas],
          createdAt,
          by: by?.id ?? "unknown",
          commits: [...records].sort((a, b) => (order.get(a.sha) ?? 0) - (order.get(b.sha) ?? 0)),
          evidence: versions.map((v) => ({ threadId: v.id, version: v.version })),
          methods: { checks: CHECKS_METHOD, detectors: DETECTORS.join(","), server: input.server },
          findings: open.map((f) => ({ id: f.id, status: f.status })),
          decision: { verdict: input.verdict, note: input.note },
        };
        yield* sql`
          INSERT INTO reviews (workspace_id, repo, id, manifest)
          VALUES (${ws}, ${input.repo}, ${manifest.id}, ${forJsonb(encodeManifestJson(manifest))}::jsonb)`.pipe(
          Effect.mapError(failed),
        );
        return manifest;
      }, bounded);

      const review = Effect.fn("HistoryStore.review")(function* (
        ws: string,
        repo: string,
        id: string,
      ) {
        const [row] = yield* sql`
          SELECT manifest FROM reviews WHERE workspace_id = ${ws} AND repo = ${repo} AND id = ${id}`.pipe(
          Effect.flatMap(decodeManifestRows),
          Effect.mapError(failed),
        );
        if (!row) return Option.none();
        const ids = row.manifest.evidence.map((e) => e.threadId);
        const [stored, gone] =
          ids.length === 0
            ? [[], []]
            : yield* Effect.all([
                sql`SELECT id, content_sha AS version FROM threads
                    WHERE workspace_id = ${ws} AND id IN ${sql.in(ids)}`.pipe(
                  Effect.flatMap(decodeVersionRows),
                ),
                sql`SELECT thread_id AS id, reason FROM removed
                    WHERE workspace_id = ${ws} AND thread_id IN ${sql.in(ids)}`.pipe(
                  Effect.flatMap(decodeRemovedReasonRows),
                ),
              ]).pipe(Effect.mapError(failed));
        const versionOf = new Map(stored.map((s) => [s.id, s.version]));
        const reasonOf = new Map(gone.map((g) => [g.id, g.reason]));
        return Option.some({
          manifest: row.manifest,
          now: row.manifest.evidence.map((e) => ({
            threadId: e.threadId,
            status: (reasonOf.get(e.threadId) ??
              (!versionOf.has(e.threadId)
                ? "missing"
                : versionOf.get(e.threadId) === e.version
                  ? "same"
                  : "replaced")) as EvidenceNow,
          })),
        });
      }, bounded);

      const deleteThread = Effect.fn("HistoryStore.deleteThread")(function* (
        slug: string,
        id: string,
      ) {
        const ws = yield* workspace(slug);
        const n = yield* remove("deleted", sql`workspace_id = ${ws} AND id = ${id}`);
        // Deleted before it was ever stored here: marked anyway, so no sync stores it later.
        if (n === 0)
          yield* sql`
            INSERT INTO removed (workspace_id, thread_id, version, reason)
            VALUES (${ws}, ${id}, '', 'deleted')
            ON CONFLICT (workspace_id, thread_id) DO UPDATE SET reason = 'deleted', removed_at = now()`.pipe(
            Effect.mapError(failed),
          );
        return n > 0;
      });

      const expire = (days: number) =>
        remove("expired", sql`uploaded_at < now() - make_interval(days => ${days})`);

      const revokeToken = Effect.fn("HistoryStore.revokeToken")(function* (
        slug: string,
        name: string,
      ) {
        const rows = yield* sql`
          WITH revoked AS (
            UPDATE api_tokens SET revoked_at = now()
            WHERE workspace_id = (SELECT id FROM workspaces WHERE slug = ${slug})
              AND name = ${name} AND revoked_at IS NULL
            RETURNING id
          )
          SELECT count(*)::int AS n FROM revoked`.pipe(
          Effect.flatMap(decodeCountRows),
          Effect.mapError(failed),
        );
        return rows[0]?.n ?? 0;
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

      const addMember = Effect.fn("HistoryStore.addMember")(function* (
        slug: string,
        login: string,
      ) {
        const ws = yield* workspace(slug);
        yield* sql`
          INSERT INTO members (workspace_id, github_login) VALUES (${ws}, ${login.toLowerCase()})
          ON CONFLICT DO NOTHING`.pipe(Effect.mapError(failed));
      }, bounded);

      const removeMember = Effect.fn("HistoryStore.removeMember")(function* (
        slug: string,
        login: string,
      ) {
        const rows = yield* sql`
          WITH gone AS (
            DELETE FROM members
            WHERE workspace_id = (SELECT id FROM workspaces WHERE slug = ${slug})
              AND github_login = ${login.toLowerCase()}
            RETURNING 1
          )
          SELECT count(*)::int AS n FROM gone`.pipe(
          Effect.flatMap(decodeCountRows),
          Effect.mapError(failed),
        );
        return (rows[0]?.n ?? 0) > 0;
      }, bounded);

      const member = Effect.fn("HistoryStore.member")(function* (slug: string, login: string) {
        const [row] = yield* sql`
          SELECT w.id::text AS id FROM members m JOIN workspaces w ON w.id = m.workspace_id
          WHERE w.slug = ${slug} AND m.github_login = ${login.toLowerCase()}`.pipe(
          Effect.flatMap(decodeIdRows),
          Effect.mapError(failed),
        );
        return Option.map(Option.fromNullishOr(row), (r) => ({ workspaceId: r.id }));
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
          threads: (ids, repo) => threads(ws, ids, repo),
          putCommit: (record) => putCommit(writer, record),
          search: (query) => search(ws, query),
          evidence: (cite) => evidence(ws, cite),
          repoThreads: (repo) => repoThreads(ws, repo),
          putDetections: (repo, detections) => putDetections(ws, repo, detections),
          findings: (repo, statuses) => findings(ws, repo, statuses),
          transition: (repo, id, to, why) => transition(writer, repo, id, to, why),
          commits: (repo, shas) => commits(ws, repo, shas),
          freezeReview: (input) => freezeReview(writer, input),
          review: (repo, id) => review(ws, repo, id),
        };
      };

      return HistoryStore.of({
        at,
        workspace,
        createToken,
        addMember,
        removeMember,
        member,
        deleteThread,
        expire,
        revokeToken,
        authenticate,
      });
    }),
  );
}
