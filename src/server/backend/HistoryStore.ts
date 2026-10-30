// Agent history in Postgres (TOOLREADER_DATABASE_URL), per workspace: threads (each one's whole
// history, replaced when it grew, never by an older read) and commits (each one's links to those
// threads, merged per thread and role when it is linked again). Workspaces and their API tokens live here too: this is the only module
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
  lastAt,
  mergeCommit,
  readCommit,
  staleCopy,
  type SOURCE_STATES,
  readThread,
  ThreadRecordV1,
  type CommitRecord,
  type ThreadRecord,
} from "../../core/historyRecord.ts";
import { Entry } from "../../core/domain.ts";
import { COVERAGE_LISTED, Coverage, type Evidence, type SearchHit } from "../../core/historyApi.ts";
import {
  corrected,
  Corrections,
  Detection,
  Finding,
  FindingEvent,
  FINDING_STATUSES,
  findQuote,
  reopenReason,
  submissionKey,
  transitionError,
  type FindingStatus,
  type Submission,
} from "../../core/insights.ts";
import { CHECKS_METHOD } from "../../core/checks.ts";
import { DETECTORS } from "../../core/insights.ts";
import { ReviewManifest, type EvidenceNow } from "../../core/review.ts";
import { hunkKey, StoredBlame } from "../../core/blame.ts";
import { forJsonb, sha256, threadSha } from "../recordHash.ts";
import { ENTRY_ROWS } from "./Migrations/005_Entries.ts";
import { HISTORY_EVENT_VIEWS } from "./Migrations/014_HistoryEvents.ts";
import { FILTERED_CODEX_VIEWS } from "./Migrations/015_FilteredCodex.ts";
import { CODEX_VIEWS } from "./Migrations/013_CodexArchive.ts";
import { AGENT_VIEWS } from "./Migrations/009_AgentSchema.ts";

type SourceState = (typeof SOURCE_STATES)[number];

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

/** An agent's finding citing entries that don't read back from this repo's threads. */
export class FindingRefused extends Schema.TaggedErrorClass<FindingRefused>()("FindingRefused", {
  message: Schema.String,
}) {}

/** A status change the lifecycle doesn't allow. */
export class FindingConflict extends Schema.TaggedErrorClass<FindingConflict>()("FindingConflict", {
  message: Schema.String,
}) {}

/** `same`: it was there with this content already. */
export type PutResult = "inserted" | "updated" | "same";
/** A thread's put: also refused because it was removed (deleted on request, or this version expired). */
export type ThreadPutResult = PutResult | "deleted" | "expired";

/**
 * The stored copy of a thread is newer than the one sent (its entries extend the sent ones, with
 * a later last entry or as late): a client that read the session earlier, or on another machine,
 * must not replace it.
 */
export class StaleThread extends Schema.TaggedErrorClass<StaleThread>()("StaleThread", {
  reason: Schema.Literals(["older-last-entry", "fewer-entries"]),
}) {}

/** Who writes: the workspace, the token (null: tests, tools, GitHub sign-ins) and the client's version. */
export type Writer = {
  readonly workspaceId: string;
  readonly tokenId: string | null;
  readonly client: string;
  /** Who decides on findings, when not a token: `github:<login>`. */
  readonly actor?: string | undefined;
};

/** A Postgres login that reads one workspace's `agent_*` views (AgentSql.ts). */
export type AgentLogin = { readonly role: string; readonly password: string };

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
const LoginRow = Schema.Struct({ role: Schema.String, password: Schema.String });
const ShaRow = Schema.Struct({ sha256: Schema.String });
const decodeShaRows = Schema.decodeUnknownEffect(Schema.Array(ShaRow));
const MimeRow = Schema.Struct({ mime: Schema.String });
const decodeMimeRows = Schema.decodeUnknownEffect(Schema.Array(MimeRow));
const OrphanRow = Schema.Struct({ workspaceId: Schema.String, sha256: Schema.String });
const decodeOrphanRows = Schema.decodeUnknownEffect(Schema.Array(OrphanRow));
const FlagRow = Schema.Struct({ media: Schema.Boolean });
const decodeFlagRows = Schema.decodeUnknownEffect(Schema.Array(FlagRow));
const decodeLoginRows = Schema.decodeUnknownEffect(Schema.Array(LoginRow));
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
const decodeStoredRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      entries: Schema.Array(
        Schema.Struct({ id: Schema.NullOr(Schema.String), at: Schema.NullOr(Schema.String) }),
      ),
    }),
  ),
);
const decodeCoverageCounts = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({ threads: Schema.Number, behind: Schema.Number, asOf: Schema.String }),
  ),
);
const decodeCoverageRows = Schema.decodeUnknownEffect(Coverage.fields.mayBeBehind);
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
  corrections: Corrections,
  detection: Detection,
  status: Schema.Literals(FINDING_STATUSES),
  events: Schema.Array(FindingEvent),
  detectedAt: Schema.String,
  updatedAt: Schema.String,
});
const decodeFindingRows = Schema.decodeUnknownEffect(Schema.Array(FindingRow));
const StatusRow = Schema.Struct({ status: Schema.Literals(FINDING_STATUSES) });
const DecisionRow = Schema.Struct({
  status: Schema.Literals(FINDING_STATUSES),
  events: Schema.Array(FindingEvent),
});
const decodeDecisionRows = Schema.decodeUnknownEffect(Schema.Array(DecisionRow));
const decodeStatusRows = Schema.decodeUnknownEffect(Schema.Array(StatusRow));
const encodeDetectionJson = Schema.encodeSync(Schema.fromJsonString(Detection));
const encodeEventJson = Schema.encodeSync(Schema.fromJsonString(FindingEvent));
const encodeIdsJson = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const findingOf = (r: typeof FindingRow.Type): Finding => ({
  ...corrected(r.detection, r.corrections),
  corrections: r.corrections,
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
const snippetOf = (
  fields: ReadonlyArray<string | null | undefined>,
  text: string,
  title?: string | null,
) => {
  // No text: the first field that isn't the title (a command, a message, an output).
  if (!text) {
    const f = fields.find((x) => x?.trim() && x !== title) ?? "";
    return f.length > 120 ? `${f.slice(0, 120).replace(/\s+/g, " ")}…` : f.replace(/\s+/g, " ");
  }
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
const RepoRow = Schema.Struct({
  repo: Schema.String,
  commits: Schema.NumberFromString,
  threads: Schema.NumberFromString,
  latest: Schema.String,
});
const decodeRepoRows = Schema.decodeUnknownEffect(Schema.Array(RepoRow));
export type RepoSummary = typeof RepoRow.Type;
const decodeBlame = Schema.decodeUnknownResult(StoredBlame);
const encodeBlameJson = Schema.encodeSync(Schema.fromJsonString(StoredBlame));
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
  /** Whether the workspace keeps images (`backend media enable`). */
  readonly mediaEnabled: Effect.Effect<boolean, HistoryStoreFailed>;
  /** Which of these image hashes the workspace doesn't hold yet. */
  readonly missingMedia: (
    shas: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string>, HistoryStoreFailed>;
  /** Records an image the bucket now holds. */
  readonly putMedia: (
    sha256: string,
    mime: string,
    bytes: number,
  ) => Effect.Effect<void, HistoryStoreFailed>;
  /** A held image's type. */
  readonly media: (
    sha256: string,
  ) => Effect.Effect<Option.Option<{ readonly mime: string }>, HistoryStoreFailed>;
  /** The stored content hash (`threadSha`) of each of `ids` this workspace holds. */
  readonly hashes: (
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, string>, HistoryStoreFailed>;
  readonly putThread: (
    record: ThreadRecord,
  ) => Effect.Effect<ThreadPutResult, HistoryStoreFailed | HistoryRefused | StaleThread>;
  /**
   * Marks the threads whose stored content hash is `version` checked now, with what their
   * source says; how many matched.
   */
  readonly checked: (
    threads: ReadonlyArray<{
      readonly id: string;
      readonly version: string;
      readonly sourceState?: SourceState | undefined;
    }>,
  ) => Effect.Effect<number, HistoryStoreFailed>;
  /** How current the workspace's copies are (`Coverage`), as of now. */
  readonly coverage: Effect.Effect<Coverage, HistoryStoreFailed>;
  /** With `repo`, only those linked to its commits. */
  readonly threads: (
    ids: ReadonlyArray<string>,
    repo?: string | undefined,
  ) => Effect.Effect<ReadonlyArray<ThreadRecord>, HistoryStoreFailed>;
  /**
   * Keeps the commit's links, merged per (thread, role) into what's stored (`mergeCommit`): a
   * link another machine sent stays until a record unlinks it.
   */
  readonly putCommit: (
    record: CommitRecord,
  ) => Effect.Effect<PutResult, HistoryStoreFailed | HistoryRefused>;
  /**
   * Entries holding `text` (any, without it), newest first; `repo` keeps threads linked to its
   * commits, `commit` those linked to that commit (SHA or prefix), `kinds` actions of those kinds.
   */
  readonly search: (query: {
    readonly text?: string | undefined;
    readonly repo?: string | undefined;
    readonly commit?: string | undefined;
    readonly kinds?: ReadonlyArray<string> | undefined;
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
  /** An agent's cited finding, kept as this writer's: new as `detected`, else its evidence. */
  readonly submit: (
    repo: string,
    submission: Submission,
  ) => Effect.Effect<
    { readonly finding: Finding; readonly added: boolean },
    HistoryStoreFailed | FindingRefused
  >;
  /** Adds sessions to or removes them from a finding's group, kept with who and why. */
  readonly correct: (
    repo: string,
    id: string,
    change: {
      readonly add: ReadonlyArray<string>;
      readonly remove: ReadonlyArray<string>;
      readonly why: string;
    },
  ) => Effect.Effect<Finding, HistoryStoreFailed | FindingMissing>;
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
  /** Repos with linked commits: how many commits and threads, and the newest commit's time. */
  readonly repos: () => Effect.Effect<ReadonlyArray<RepoSummary>, HistoryStoreFailed>;
  /** A repo's linked commits, newest first: `limit` of them committed before `before`. */
  readonly ledger: (
    repo: string,
    before: string | null,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<CommitRecord>, HistoryStoreFailed>;
  readonly blame: (
    repo: string,
    sha: string,
    hunk: string,
    model: string,
  ) => Effect.Effect<Option.Option<StoredBlame>, HistoryStoreFailed>;
  /** Keeps the first answer for a hunk: a second, concurrent one is dropped. */
  readonly putBlame: (blame: StoredBlame) => Effect.Effect<void, HistoryStoreFailed>;
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
    /**
     * The workspace's agent login (`agent_logins`, Migrations/009): made on first use, which needs
     * CREATEROLE. It reads the `agent_*` views, only its workspace's rows.
     */
    readonly agentLogin: (workspaceId: string) => Effect.Effect<AgentLogin, HistoryStoreFailed>;
    /** Lets the workspace keep images, or stops it (those it holds stay until swept). */
    readonly setMedia: (workspace: string, on: boolean) => Effect.Effect<void, HistoryStoreFailed>;
    /**
     * Images no thread of their workspace cites any more, held over an hour (an upload lands
     * before the thread citing it), or in a workspace that stopped keeping media.
     */
    readonly orphanMedia: Effect.Effect<
      ReadonlyArray<{ readonly workspaceId: string; readonly sha256: string }>,
      HistoryStoreFailed
    >;
    readonly dropMedia: (
      workspaceId: string,
      sha256: string,
    ) => Effect.Effect<void, HistoryStoreFailed>;
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
        function* (writer: Writer, sent: ThreadRecord) {
          // Its last entry as its entries say, not as the client did.
          const { lastEntryAt: _, ...rest } = sent;
          const last = lastAt(sent.entries);
          const record: ThreadRecord = last ? { ...rest, lastEntryAt: last } : rest;
          // Deleted on request: never stored again. Expired: not this version again.
          const [gone] = yield* sql`
            SELECT version, reason FROM removed
            WHERE workspace_id = ${writer.workspaceId} AND thread_id = ${record.thread.id}`.pipe(
            Effect.flatMap(decodeRemovedRows),
          );
          if (gone?.reason === "deleted") return "deleted" as const;
          if (gone && gone.version === threadSha(record)) return "expired" as const;
          if (gone)
            yield* sql`
              DELETE FROM removed
              WHERE workspace_id = ${writer.workspaceId} AND thread_id = ${record.thread.id}`;
          // An older read of the same history never replaces a newer one, whatever client sent
          // it: judged on the entries (`staleCopy`), never on the `lastEntryAt` a client claims.
          yield* sql`
            SELECT 1 FROM threads
            WHERE workspace_id = ${writer.workspaceId} AND id = ${record.thread.id} FOR UPDATE`;
          const [stored] = yield* sql`
            SELECT coalesce(jsonb_agg(jsonb_build_object('id', e->>'id', 'at', e->>'at')
                                      ORDER BY n), '[]'::jsonb) AS entries
            FROM threads t, jsonb_array_elements(t.payload->'entries') WITH ORDINALITY x(e, n)
            WHERE t.workspace_id = ${writer.workspaceId} AND t.id = ${record.thread.id}`.pipe(
            Effect.flatMap(decodeStoredRows),
          );
          const stale = staleCopy(sent.entries, stored?.entries ?? []);
          if (stale) return yield* new StaleThread({ reason: stale });
          const payload = forJsonb(encodeThreadJson(record));
          const result = yield* upsert(
            "threads",
            { id: record.thread.id },
            payload,
            threadSha(record),
            writer,
          );
          // Checked now, whatever changed: this client read the session and sent what it found.
          yield* sql`
            UPDATE threads SET checked_at = now(), source_state = ${record.sourceState ?? null}
            WHERE workspace_id = ${writer.workspaceId} AND id = ${record.thread.id}`;
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
        Effect.mapError((e) => (e._tag === "StaleThread" ? e : putFailed(e))),
        bounded,
      );

      const putCommit = Effect.fn("HistoryStore.putCommit")(
        function* (writer: Writer, incoming: CommitRecord) {
          // The first put inserts; any other merges into what's there per (thread, role), under
          // its row lock: machines that sync the same commit, at once too, each keep their links.
          const first = mergeCommit(null, incoming);
          const inserted = yield* sql`
            INSERT INTO commits ${sql.insert({
              workspace_id: writer.workspaceId,
              repo: first.repo,
              sha: first.sha,
              payload: forJsonb(encodeCommitJson(first)),
              content_sha: commitSha(first),
              uploaded_by: writer.tokenId,
              client: writer.client,
            })}
            ON CONFLICT (workspace_id, repo, sha) DO NOTHING
            RETURNING sha`;
          if (inserted.length > 0) return "inserted" as const;
          const [row] = yield* sql`
            SELECT payload FROM commits
            WHERE workspace_id = ${writer.workspaceId} AND repo = ${incoming.repo}
              AND sha = ${incoming.sha}
            FOR UPDATE`.pipe(Effect.flatMap(decodePayloadRows));
          // One a newer toolreader wrote can't be merged into: replaced, as before merging.
          const stored = row ? Result.getOrNull(readCommit(row.payload)) : null;
          const record = mergeCommit(stored, incoming);
          return yield* upsert(
            "commits",
            { repo: record.repo, sha: record.sha },
            forJsonb(encodeCommitJson(record)),
            commitSha(record),
            writer,
          );
        },
        (self) => sql.withTransaction(self),
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

      const checked = Effect.fn("HistoryStore.checked")(
        function* (
          ws: string,
          found: ReadonlyArray<{
            readonly id: string;
            readonly version: string;
            readonly sourceState?: SourceState | undefined;
          }>,
        ) {
          let n = 0;
          // ponytail: one UPDATE per thread (at most LIMITS.ids); batch it if syncs get slow.
          for (const t of found) {
            const rows = yield* sql`
              UPDATE threads SET checked_at = now(), source_state = ${t.sourceState ?? null}
              WHERE workspace_id = ${ws} AND id = ${t.id} AND content_sha = ${t.version}
              RETURNING id`.pipe(Effect.flatMap(decodeIdRows));
            n += rows.length;
          }
          return n;
        },
        (self) => sql.withTransaction(self),
        Effect.mapError(failed),
        bounded,
      );

      const coverage = Effect.fn("HistoryStore.coverage")(
        function* (ws: string) {
          // Running when last checked, or not checked within the hour: may be behind its source.
          const behind = sql`
            workspace_id = ${ws}
            AND (source_state = 'running' OR checked_at IS NULL
                 OR checked_at < now() - interval '1 hour')`;
          const [counts] = yield* sql`
            SELECT count(*)::int AS threads, (count(*) FILTER (WHERE ${behind}))::int AS behind,
                   to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "asOf"
            FROM threads WHERE workspace_id = ${ws}`.pipe(Effect.flatMap(decodeCoverageCounts));
          const rows = yield* sql`
            SELECT id, coalesce(payload->'thread'->>'title', '') AS title,
                   coalesce(source_state, 'unknown') AS state,
                   coalesce(payload->>'lastEntryAt',
                            (SELECT max(e->>'at') FROM jsonb_array_elements(payload->'entries') e))
                     AS "lastEntryAt",
                   to_char(checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                     AS "checkedAt"
            FROM threads WHERE ${behind}
            ORDER BY (source_state = 'running') DESC NULLS LAST, checked_at DESC NULLS LAST, id
            LIMIT ${COVERAGE_LISTED}`.pipe(Effect.flatMap(decodeCoverageRows));
          return {
            asOf: counts!.asOf,
            threads: counts!.threads,
            behind: counts!.behind,
            mayBeBehind: rows,
          } satisfies Coverage;
        },
        Effect.mapError(failed),
        bounded,
      );

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
          readonly text?: string | undefined;
          readonly repo?: string | undefined;
          readonly commit?: string | undefined;
          readonly kinds?: ReadonlyArray<string> | undefined;
          readonly limit: number;
        },
      ) {
        const text = query.text ?? "";
        const matching = text ? sql`AND n.search ILIKE ${containing(text)}` : sql``;
        const inRepo = query.repo ? sql`AND n.thread_id IN (${linkedTo(ws, query.repo)})` : sql``;
        const inCommit = query.commit
          ? sql`AND n.thread_id IN (
              SELECT l->>'threadId' FROM commits c, jsonb_array_elements(c.payload->'links') l
              WHERE c.workspace_id = ${ws} AND c.sha LIKE ${`${query.commit}%`}
              ${query.repo ? sql`AND c.repo = ${query.repo}` : sql``})`
          : sql``;
        const ofKinds = query.kinds?.length
          ? sql`AND n.type = 'action' AND n.kind IN ${sql.in(query.kinds)}`
          : sql``;
        const rows = yield* sql`
          SELECT n.thread_id AS "threadId", n.thread_title AS "threadTitle",
                 t.content_sha AS version, n.entry_id AS "entryId", n.at, n.type, n.kind,
                 n.status, n.title, n.search
          FROM entries n
          JOIN threads t ON t.workspace_id = n.workspace_id AND t.id = n.thread_id
          WHERE n.workspace_id = ${ws} ${matching} ${inRepo} ${inCommit} ${ofKinds}
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
          snippet: snippetOf(r.search.split("\u001f"), text, r.title),
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
          if (row?.inserted) {
            added++;
            continue;
          }
          // New evidence reopens a rejected finding, saying what's new.
          const [current] = yield* sql`
            SELECT status, events FROM findings
            WHERE workspace_id = ${ws} AND repo = ${repo} AND key = ${d.key}`.pipe(
            Effect.flatMap(decodeDecisionRows),
            Effect.mapError(failed),
          );
          const why = current?.status === "rejected" ? reopenReason(d, current.events) : null;
          if (!why) continue;
          const event = encodeEventJson({
            from: "rejected",
            to: "proposed",
            by: d.by ?? "detector",
            at: DateTime.formatIso(yield* DateTime.now),
            why,
          });
          yield* sql`
            UPDATE findings
            SET status = 'proposed', events = events || jsonb_build_array(${event}::jsonb),
                updated_at = now()
            WHERE workspace_id = ${ws} AND repo = ${repo} AND key = ${d.key}
              AND status = 'rejected'`.pipe(Effect.mapError(failed));
        }
        return { found: detections.length, added };
      }, bounded);

      const submit = Effect.fn("HistoryStore.submit")(function* (
        writer: Writer,
        repo: string,
        submission: Submission,
      ) {
        const ws = writer.workspaceId;
        const read = yield* Effect.forEach(submission.citations, (c) =>
          evidence(ws, { ...c, repo }),
        );
        // Each citation's quote as its entry has it; a citation that doesn't read, or whose quote
        // isn't in its entry, refuses the finding.
        const quotes = submission.citations.map((c, i) => {
          const entry = read[i]!.entry;
          return read[i]!.status === "ok" && entry ? findQuote(entry, c.quote) : null;
        });
        const unreadable = submission.citations.flatMap((c, i) => {
          if (quotes[i] !== null) return [];
          const r = read[i]!;
          const status: string = r.status;
          const why =
            status !== "ok"
              ? status
              : r.entry
                ? `quote not in the entry: "${c.quote.slice(0, 60)}"`
                : "no such entry";
          return [
            `${c.threadId}#${c.entryId}${c.version ? `@${c.version.slice(0, 12)}` : ""} (${why})`,
          ];
        });
        if (unreadable.length > 0)
          return yield* new FindingRefused({
            message: `Citations that don't hold in ${repo}'s threads: ${unreadable.join(", ")}`,
          });
        const [by] = writer.actor
          ? [{ id: writer.actor }]
          : writer.tokenId
            ? yield* sql`SELECT name AS id FROM api_tokens WHERE id = ${writer.tokenId}`.pipe(
                Effect.flatMap(decodeIdRows),
                Effect.mapError(failed),
              )
            : [];
        const key = submissionKey(submission.subject);
        // ponytail: sessions counted by thread; a subagent's citation counts apart from its parent's.
        const detection: Detection = {
          key,
          detector: "agent",
          subject: submission.subject,
          sessions: new Set(submission.citations.map((c) => c.threadId)).size,
          occurrences: submission.citations.map((c, i) => ({
            threadId: c.threadId,
            entryId: c.entryId,
            at: read[i]!.entry!.at,
            ...((read[i]!.version ?? c.version) ? { version: read[i]!.version ?? c.version } : {}),
            quote: quotes[i]!,
          })),
          pattern: submission.pattern,
          suggestion: submission.suggestion,
          by: by?.id ?? "unknown",
        };
        const { added } = yield* putDetections(ws, repo, [detection]);
        const finding = (yield* findings(ws, repo)).find((f) => f.key === key);
        if (!finding)
          return yield* new HistoryStoreFailed({ message: "submitted finding not stored" });
        return { finding, added: added === 1 };
      }, bounded);

      const findingColumns = sql`
        id, detection, status, events, corrections,
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

      const correct = Effect.fn("HistoryStore.correct")(
        function* (
          writer: Writer,
          repo: string,
          id: string,
          change: {
            readonly add: ReadonlyArray<string>;
            readonly remove: ReadonlyArray<string>;
            readonly why: string;
          },
        ) {
          const ws = writer.workspaceId;
          const [current] = yield* sql`
            SELECT status FROM findings
            WHERE workspace_id = ${ws} AND repo = ${repo} AND id = ${id} FOR UPDATE`.pipe(
            Effect.flatMap(decodeStatusRows),
            Effect.mapError(failed),
          );
          if (!current)
            return yield* new FindingMissing({ message: `No finding ${id} in ${repo}` });
          const [by] = writer.actor
            ? [{ id: writer.actor }]
            : writer.tokenId
              ? yield* sql`SELECT name AS id FROM api_tokens WHERE id = ${writer.tokenId}`.pipe(
                  Effect.flatMap(decodeIdRows),
                  Effect.mapError(failed),
                )
              : [];
          // A status-keeping event, so the change shows in the finding's history with its why.
          const event = encodeEventJson({
            from: current.status,
            to: current.status,
            by: by?.id ?? "unknown",
            at: DateTime.formatIso(yield* DateTime.now),
            why: `members ${[...change.add.map((t) => `+${t}`), ...change.remove.map((t) => `-${t}`)].join(" ")}: ${change.why}`,
          });
          const add = forJsonb(encodeIdsJson(change.add));
          const remove = forJsonb(encodeIdsJson(change.remove));
          const [row] = yield* sql`
            UPDATE findings SET
              corrections = jsonb_build_object(
                'add', (SELECT coalesce(jsonb_agg(DISTINCT x), '[]'::jsonb) FROM jsonb_array_elements_text(
                  (corrections->'add') || ${add}::jsonb) x WHERE NOT (${remove}::jsonb ? x)),
                'remove', (SELECT coalesce(jsonb_agg(DISTINCT x), '[]'::jsonb) FROM jsonb_array_elements_text(
                  (corrections->'remove') || ${remove}::jsonb) x WHERE NOT (${add}::jsonb ? x))),
              events = events || jsonb_build_array(${event}::jsonb),
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

      const repos = Effect.fn("HistoryStore.repos")(function* (ws: string) {
        return yield* sql`
          SELECT c.repo, count(DISTINCT c.sha)::text AS commits,
                 count(DISTINCT link->>'threadId')::text AS threads,
                 to_char(max((c.payload->>'committedAt')::timestamptz) AT TIME ZONE 'UTC',
                         'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS latest
          FROM commits c, jsonb_array_elements(c.payload->'links') AS link
          WHERE c.workspace_id = ${ws}
          GROUP BY c.repo ORDER BY latest DESC`.pipe(
          Effect.flatMap(decodeRepoRows),
          Effect.mapError(failed),
        );
      }, bounded);

      const ledger = Effect.fn("HistoryStore.ledger")(function* (
        ws: string,
        repo: string,
        before: string | null,
        limit: number,
      ) {
        const rows = yield* sql`
          SELECT payload FROM commits
          WHERE workspace_id = ${ws} AND repo = ${repo}
            AND jsonb_array_length(payload->'links') > 0
            ${
              before === null
                ? sql``
                : sql`AND ((payload->>'committedAt')::timestamptz, sha) < (
              SELECT (payload->>'committedAt')::timestamptz, sha FROM commits
              WHERE workspace_id = ${ws} AND repo = ${repo} AND sha = ${before}
            )`
            }
          ORDER BY (payload->>'committedAt')::timestamptz DESC, sha DESC LIMIT ${limit}`.pipe(
          Effect.flatMap(decodePayloadRows),
          Effect.mapError(failed),
        );
        return yield* read(
          rows.map((r) => r.payload),
          readCommit,
        );
      }, bounded);

      const blame = Effect.fn("HistoryStore.blame")(function* (
        ws: string,
        repo: string,
        sha: string,
        hunk: string,
        model: string,
      ) {
        const [row] = yield* sql`
          SELECT payload FROM blames
          WHERE workspace_id = ${ws} AND repo = ${repo} AND sha = ${sha}
            AND hunk = ${hunk} AND model = ${model}`.pipe(
          Effect.flatMap(decodePayloadRows),
          Effect.mapError(failed),
        );
        if (!row) return Option.none<StoredBlame>();
        return Result.match(decodeBlame(row.payload), {
          onSuccess: Option.some,
          // Written by another build: ask again rather than fail the page.
          onFailure: () => Option.none<StoredBlame>(),
        });
      }, bounded);

      const putBlame = Effect.fn("HistoryStore.putBlame")(function* (
        ws: string,
        record: StoredBlame,
      ) {
        yield* sql`
          INSERT INTO blames ${sql.insert({
            workspace_id: ws,
            repo: record.repo,
            sha: record.sha,
            hunk: hunkKey(record.path, record.hunk.header),
            model: record.model,
            payload: forJsonb(encodeBlameJson(record)),
          })}
          ON CONFLICT (workspace_id, repo, sha, hunk, model) DO UPDATE
            SET payload = excluded.payload, created_at = now()`.pipe(Effect.mapError(failed));
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

      // The settings bound an agent's session even before AgentSql sets its own; it can't SET ROLE
      // anywhere (it is a member of no role). Name and password are random hex: safe to inline in
      // the DDL, which takes no parameters.
      const agentLogin = Effect.fn("HistoryStore.agentLogin")(
        function* (workspaceId: string) {
          const existing = sql`
            SELECT role_name AS role, password FROM agent_logins
            WHERE workspace_id = ${workspaceId}`.pipe(Effect.flatMap(decodeLoginRows));
          const [found] = yield* existing;
          if (found) return found;
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`;
              const [raced] = yield* existing;
              if (raced) return raced;
              const role = `tr_agent_${NodeCrypto.randomBytes(8).toString("hex")}`;
              // ponytail: sent in clear, so a server logging DDL logs it; send a SCRAM verifier
              // if that matters.
              const password = NodeCrypto.randomBytes(24).toString("hex");
              yield* sql.unsafe(
                `CREATE ROLE ${role} LOGIN NOINHERIT CONNECTION LIMIT 5 PASSWORD '${password}'`,
              );
              yield* sql.unsafe(`ALTER ROLE ${role} SET statement_timeout = '30s'`);
              yield* sql.unsafe(`ALTER ROLE ${role} SET default_transaction_read_only = on`);
              yield* sql.unsafe(
                `DO $$ BEGIN EXECUTE format('GRANT USAGE ON SCHEMA %I TO ${role}', current_schema()); END $$`,
              );
              yield* sql.unsafe(
                `GRANT SELECT ON ${[...AGENT_VIEWS, ...CODEX_VIEWS, ...HISTORY_EVENT_VIEWS, ...FILTERED_CODEX_VIEWS].join(", ")} TO ${role}`,
              );
              yield* sql`
                INSERT INTO agent_logins (workspace_id, role_name, password)
                VALUES (${workspaceId}, ${role}, ${password})`;
              return { role, password };
            }),
          );
        },
        Effect.mapError(failed),
        bounded,
      );

      const mediaEnabled = (ws: string) =>
        sql`SELECT media FROM workspaces WHERE id = ${ws}`.pipe(
          Effect.flatMap(decodeFlagRows),
          Effect.map(([r]) => r?.media ?? false),
          Effect.mapError(failed),
        );

      const missingMedia = (ws: string, shas: ReadonlyArray<string>) =>
        shas.length === 0
          ? Effect.succeed([])
          : sql`
              SELECT sha256 FROM media WHERE workspace_id = ${ws} AND sha256 IN ${sql.in(shas)}`.pipe(
              Effect.flatMap(decodeShaRows),
              Effect.map((held) => {
                const have = new Set(held.map((r) => r.sha256));
                return [...new Set(shas)].filter((sha) => !have.has(sha));
              }),
              Effect.mapError(failed),
            );

      const putMedia = (ws: string, sha256: string, mime: string, bytes: number) =>
        sql`
          INSERT INTO media (workspace_id, sha256, mime, bytes) VALUES (${ws}, ${sha256}, ${mime}, ${bytes})
          ON CONFLICT DO NOTHING`.pipe(Effect.asVoid, Effect.mapError(failed));

      const media = (ws: string, sha256: string) =>
        sql`SELECT mime FROM media WHERE workspace_id = ${ws} AND sha256 = ${sha256}`.pipe(
          Effect.flatMap(decodeMimeRows),
          Effect.map((rows) => Option.fromNullishOr(rows[0])),
          Effect.mapError(failed),
        );

      const setMedia = Effect.fn("HistoryStore.setMedia")(function* (slug: string, on: boolean) {
        const ws = yield* workspace(slug);
        yield* sql`UPDATE workspaces SET media = ${on} WHERE id = ${ws}`.pipe(
          Effect.mapError(failed),
        );
      }, bounded);

      // ponytail: scans every cited hash; index the citations if workspaces grow past ~1e5 images.
      const orphanMedia = sql`
        SELECT m.workspace_id::text AS "workspaceId", m.sha256 FROM media m
        JOIN workspaces w ON w.id = m.workspace_id
        WHERE NOT w.media OR (m.uploaded_at < now() - interval '1 hour' AND NOT EXISTS (
          SELECT 1 FROM threads t,
               jsonb_array_elements(t.payload->'entries') e,
               jsonb_array_elements(coalesce(e->'media', '[]'::jsonb)) x
          WHERE t.workspace_id = m.workspace_id AND x->>'sha256' = m.sha256)
          AND NOT EXISTS (
          SELECT 1 FROM codex_events e JOIN codex_artifacts a
            ON a.workspace_id=e.workspace_id AND a.session_id=e.session_id AND a.sha256=e.sha256
          WHERE e.workspace_id=m.workspace_id AND a.copy_kind='filtered'
            AND e.raw::text LIKE '%toolreader-media:' || m.sha256 || '%'))`.pipe(
        Effect.flatMap(decodeOrphanRows),
        Effect.mapError(failed),
        bounded,
      );

      const dropMedia = (workspaceId: string, sha256: string) =>
        sql`DELETE FROM media WHERE workspace_id = ${workspaceId} AND sha256 = ${sha256}`.pipe(
          Effect.asVoid,
          Effect.mapError(failed),
        );

      const at = (writer: Writer): WorkspaceStore => {
        const ws = writer.workspaceId;
        return {
          mediaEnabled: mediaEnabled(ws),
          missingMedia: (shas) => missingMedia(ws, shas),
          putMedia: (sha256, mime, bytes) => putMedia(ws, sha256, mime, bytes),
          media: (sha256) => media(ws, sha256),
          hashes: (ids) => hashes(ws, ids),
          putThread: (record) => putThread(writer, record),
          checked: (threads) => checked(ws, threads),
          coverage: coverage(ws),
          threads: (ids, repo) => threads(ws, ids, repo),
          putCommit: (record) => putCommit(writer, record),
          search: (query) => search(ws, query),
          evidence: (cite) => evidence(ws, cite),
          repoThreads: (repo) => repoThreads(ws, repo),
          putDetections: (repo, detections) => putDetections(ws, repo, detections),
          findings: (repo, statuses) => findings(ws, repo, statuses),
          submit: (repo, submission) => submit(writer, repo, submission),
          transition: (repo, id, to, why) => transition(writer, repo, id, to, why),
          correct: (repo, id, change) => correct(writer, repo, id, change),
          commits: (repo, shas) => commits(ws, repo, shas),
          repos: () => repos(ws),
          ledger: (repo, before, limit) => ledger(ws, repo, before, limit),
          blame: (repo, sha, hunk, model) => blame(ws, repo, sha, hunk, model),
          putBlame: (record) => putBlame(ws, record),
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
        agentLogin,
        setMedia,
        orphanMedia,
        dropMedia,
        authenticate,
      });
    }),
  );
}
