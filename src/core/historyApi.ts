// The history backend's HTTP contract, v1: shared by the backend (src/server/backend/Backend.ts)
// and its clients. Browser-safe, like api.ts: never put server code here. Inside /v1, changes are
// additive only; a breaking one is /v2, served next to it.
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpApiSecurity from "effect/unstable/httpapi/HttpApiSecurity";

import { StoredBlame } from "./blame.ts";
import { CommitRecordV1, REJECT_REASONS, REPO_MAX, ThreadRecordV1 } from "./historyRecord.ts";
import { ACTION_KINDS, ActionKind, Entry } from "./domain.ts";
import { Finding, FINDING_STATUSES } from "./insights.ts";
import { EVIDENCE_NOW, ReviewManifest, VERDICTS } from "./review.ts";

export const API_VERSION = 1;
/** Every request names the client's version (package.json's) in this header. */
export const CLIENT_HEADER = "toolreader-client";

export const LIMITS = {
  /** Bytes of one request's body (one thread's whole history, outputs clipped): 413. */
  requestBytes: 64 * 1024 * 1024,
  /** Ids per `hashes`, SHAs per `commits`. */
  ids: 500,
  /** Commits per `ledger` page. */
  ledger: 100,
  /**
   * Whole threads per `threads` read: each can be tens of MB. ponytail: a count, not a byte budget;
   * page by bytes if threads grow past ~50 MB.
   */
  threads: 10,
  /** Hits per `search`. */
  hits: 100,
  /** Characters of a search's text. */
  query: 200,
  /** Characters of an agent's SQL. */
  sql: 20_000,
} as const;

export class Unauthorized extends Schema.TaggedErrorClass<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

export class Forbidden extends Schema.TaggedErrorClass<Forbidden>()(
  "Forbidden",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

export class TooLarge extends Schema.TaggedErrorClass<TooLarge>()(
  "TooLarge",
  { message: Schema.String, maxBytes: Schema.Number },
  { httpApiStatus: 413 },
) {}

export class LengthRequired extends Schema.TaggedErrorClass<LengthRequired>()(
  "LengthRequired",
  { message: Schema.String },
  { httpApiStatus: 411 },
) {}

/** A record this backend will never store (`admitThread`/`admitCommit`); don't send it again. */
export class Rejected extends Schema.TaggedErrorClass<Rejected>()(
  "Rejected",
  { reason: Schema.Literals(REJECT_REASONS), detail: Schema.String },
  { httpApiStatus: 422 },
) {}

export class UpgradeRequired extends Schema.TaggedErrorClass<UpgradeRequired>()(
  "UpgradeRequired",
  { message: Schema.String, minClient: Schema.String },
  { httpApiStatus: 426 },
) {}

export class NotFound extends Schema.TaggedErrorClass<NotFound>()(
  "NotFound",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

/** The request doesn't fit what's stored (a finding's lifecycle): 409, and says why. */
export class Conflict extends Schema.TaggedErrorClass<Conflict>()(
  "Conflict",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

/** Postgres refused an agent's SQL (its syntax, a permission, the timeout), in its own words. */
export class QueryRefused extends Schema.TaggedErrorClass<QueryRefused>()(
  "QueryRefused",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

/** The backend failed (its database): retry later. Never quotes record text. */
export class BackendFailed extends Schema.TaggedErrorClass<BackendFailed>()(
  "BackendFailed",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

export const Meta = Schema.Struct({
  server: Schema.String,
  apiVersion: Schema.Literal(API_VERSION),
  minClient: Schema.String,
  formats: Schema.Array(Schema.Number),
});
export type Meta = typeof Meta.Type;

/** `same`: stored with this content already. */
export const PutResult = Schema.Struct({
  result: Schema.Literals(["inserted", "updated", "same"]),
});

/**
 * The caller, as its credential names it: what `Authorization` gives every handler behind it. A
 * workspace token (`trk_…`, machines that sync) or a person signed in with GitHub (`github`: their
 * login and token, which every repo they read is checked against).
 */
export class Caller extends Context.Service<
  Caller,
  {
    readonly workspaceId: string;
    readonly workspace: string;
    readonly tokenId: string | null;
    readonly github: { readonly login: string; readonly token: string } | null;
  }
>()("toolreader/core/historyApi/Caller") {}

/** How to sign in to this backend: GitHub's device flow with this client id, or not at all. */
export const SignIn = Schema.Struct({
  github: Schema.NullOr(Schema.Struct({ clientId: Schema.String, webUrl: Schema.String })),
});

/** Bearer token → its workspace; 401 without a live token, 403 for another workspace's `:ws`. */
export class Authorization extends HttpApiMiddleware.Service<Authorization, { provides: Caller }>()(
  "toolreader/core/historyApi/Authorization",
  { security: { bearer: HttpApiSecurity.bearer }, error: [Unauthorized, Forbidden, BackendFailed] },
) {}

/** `Toolreader-Client` below the backend's `minClient`, or missing: 426. */
export class ClientVersion extends HttpApiMiddleware.Service<ClientVersion>()(
  "toolreader/core/historyApi/ClientVersion",
  { error: UpgradeRequired },
) {}

/**
 * A body over `LIMITS.requestBytes` (by Content-Length): 413, before it is read. A body without a
 * Content-Length (chunked): 411.
 */
export class BodyLimit extends HttpApiMiddleware.Service<BodyLimit>()(
  "toolreader/core/historyApi/BodyLimit",
  { error: [TooLarge, LengthRequired] },
) {}

export class SystemApi extends HttpApiGroup.make("system")
  .add(
    HttpApiEndpoint.get("health", "/health", { success: Schema.Struct({ ok: Schema.Boolean }) }),
    HttpApiEndpoint.get("signIn", "/sign-in", { success: SignIn }),
    HttpApiEndpoint.get("meta", "/meta", { success: Meta }).middleware(Authorization),
  )
  .prefix("/v1") {}

/** Path and query text: Postgres text can't hold NUL, which would fail the query (503). */
const Text = Schema.String.check(
  Schema.makeFilter((s: string) => !s.includes("\u0000"), { expected: "text without NUL" }),
);
/** `owner/name`. */
const Repo = Text.check(Schema.isMaxLength(REPO_MAX));
const ws = { ws: Text };
/** A commit id: hex, at most SHA-256 long. */
const Sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{4,64}$/));
const Ids = Schema.Array(Text).check(Schema.isMaxLength(LIMITS.ids));

/**
 * One entry a search found, cited by thread, entry and the thread's content hash (the version it
 * was found in: a thread replaced since may say something else there).
 */
export const SearchHit = Schema.Struct({
  threadId: Schema.String,
  threadTitle: Schema.String,
  version: Schema.String,
  entryId: Schema.String,
  at: Schema.String,
  type: Schema.Literals(["action", "message"]),
  /** An action's kind and status; a message's role. */
  kind: Schema.String,
  status: Schema.optional(Schema.String),
  title: Schema.String,
  /** The match with some text around it, from whichever field held it. */
  snippet: Schema.String,
});
export type SearchHit = typeof SearchHit.Type;

/**
 * What a citation reads now: its entry, or why not. `version-unavailable`: the thread was
 * replaced since (the entry may say something else now); `withheld`: not this caller's to read;
 * `deleted` / `expired`: removed on request, or past the retention period; `missing`: never here.
 */
export const EVIDENCE_STATUSES = [
  "ok",
  "version-unavailable",
  "withheld",
  "deleted",
  "expired",
  "missing",
] as const;
export const Evidence = Schema.Struct({
  status: Schema.Literals(EVIDENCE_STATUSES),
  entry: Schema.optional(Entry),
  /** The version stored now, when there is one. */
  version: Schema.optional(Schema.String),
});
export type Evidence = typeof Evidence.Type;

/** What an agent's SQL can read: the `sql` endpoint's views, as agents are told about them. */
export const AGENT_SCHEMA = `Read-only Postgres SQL over every agent conversation in the workspace, whoever's machine it ran on. One statement; at most 1000 rows, 1 MB and 10 s. Two views:

agent_threads: one row per conversation.
  id (T3 thread ids are bare; codex:<id>, claude:<id>), title (its first prompt), source (t3|codex|claude), provider, origin (the client that ran it), parent (the conversation that delegated this one, for a subagent; null otherwise), snapshot (jsonb: how it started, e.g. startCommit, branch), taken_at, uploaded_at, version, entry_count.

agent_entries: one row per step, in order.
  thread_id, seq (order in the conversation), turn (user messages so far: a turn's steps share it), entry_id, at (ISO time, text), type (action|message|event), kind (an action's kind: read|search|edit|git|docker|setup|build|run|test|web|tool|agent; a message's role: user|assistant|reasoning; an event's tone: error|info), status (ok|failed|running|unknown), title (one-line summary), hint (the agent's stated intent), command, exit_code, output (clipped to 8 KB), text (a message's or event's text), files (jsonb: [{path, added, removed, isNew, isDeleted, diff}]).

Examples:
  SELECT id, title FROM agent_threads WHERE parent = '<id>'                      -- what a conversation delegated
  SELECT turn, seq, kind, status, title FROM agent_entries WHERE thread_id = '<id>' AND type = 'action' ORDER BY seq
  SELECT thread_id, title, output FROM agent_entries WHERE status = 'failed' ORDER BY at DESC LIMIT 20`;

export const SqlResult = Schema.Struct({
  rows: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  /** Rows past the backend's row or byte cap were dropped. */
  truncated: Schema.Boolean,
});
export type SqlResult = typeof SqlResult.Type;

export class HistoryApi extends HttpApiGroup.make("history")
  .add(
    // Which of these threads the workspace holds, by content hash: the client sends only the ones
    // missing or changed.
    HttpApiEndpoint.post("hashes", "/workspaces/:ws/threads/hashes", {
      params: ws,
      payload: Schema.Struct({ ids: Ids }),
      success: Schema.Struct({ hashes: Schema.Record(Schema.String, Schema.String) }),
      error: [Forbidden, BackendFailed],
    }),
    // A thread's whole history; replaces the stored one when it changed. Decoded by
    // `admitThread`, so a record it refuses is a 422 that says why.
    HttpApiEndpoint.put("putThread", "/workspaces/:ws/threads", {
      params: ws,
      payload: Schema.Unknown,
      success: PutResult,
      error: [Rejected, Forbidden, BackendFailed],
    }),
    HttpApiEndpoint.post("threads", "/workspaces/:ws/threads/query", {
      params: ws,
      payload: Schema.Struct({
        ids: Schema.Array(Text).check(Schema.isMaxLength(LIMITS.threads)),
        /** Only threads linked to this repo's commits; required for a GitHub sign-in. */
        repo: Schema.optional(Repo),
      }),
      success: Schema.Struct({ threads: Schema.Array(ThreadRecordV1) }),
      error: [Forbidden, BackendFailed],
    }),
    // A commit's links; replaces what was stored for it.
    HttpApiEndpoint.put("putCommit", "/workspaces/:ws/commits", {
      params: ws,
      payload: Schema.Unknown,
      success: PutResult,
      error: [Rejected, Forbidden, BackendFailed],
    }),
    // Entries whose title, command, output, text or file paths hold `text` (any case), newest
    // first. With `repo`, only threads linked to that repo's commits.
    HttpApiEndpoint.post("search", "/workspaces/:ws/search", {
      params: ws,
      payload: Schema.Struct({
        /** Without it, the newest entries the other filters keep. */
        text: Schema.optional(Text.check(Schema.isMinLength(2), Schema.isMaxLength(LIMITS.query))),
        repo: Schema.optional(Repo),
        /** Only threads linked to this commit (a SHA or its prefix). */
        commit: Schema.optional(Sha),
        /** Only actions of these kinds. */
        kinds: Schema.optional(
          Schema.Array(ActionKind).check(Schema.isMaxLength(ACTION_KINDS.length)),
        ),
        limit: Schema.optional(
          Schema.Number.check(
            Schema.isInt(),
            Schema.isBetween({ minimum: 1, maximum: LIMITS.hits }),
          ),
        ),
      }),
      success: Schema.Struct({
        hits: Schema.Array(SearchHit),
        /** More entries matched than `limit`. */
        truncated: Schema.Boolean,
      }),
      error: [Forbidden, BackendFailed],
    }),
    // A citation (thread, entry, version) read back: the entry when that version is stored,
    // else why not. A GitHub sign-in names the repo, and reads only threads linked to it.
    HttpApiEndpoint.post("evidence", "/workspaces/:ws/evidence", {
      params: ws,
      payload: Schema.Struct({
        threadId: Text,
        entryId: Text,
        version: Schema.optional(Text),
        repo: Schema.optional(Repo),
      }),
      success: Evidence,
      error: [Forbidden, BackendFailed],
    }),
    // Runs the Insights detectors (core/insights.ts) over the threads linked to the repo's commits
    // and keeps what they found: new findings as `detected`, known ones with fresh evidence.
    HttpApiEndpoint.post("detect", "/workspaces/:ws/repos/:repo/insights/detect", {
      params: { ...ws, repo: Repo },
      success: Schema.Struct({ found: Schema.Number, added: Schema.Number }),
      error: [Forbidden, BackendFailed],
    }),
    // An agent's finding from its own investigation: every citation must read back from a thread
    // linked to the repo, and its quote must be in that entry (409 naming those that fail), so a
    // reader sees what each citation is about. It lands as `detected`, kept with who submitted
    // it; the same subject again updates its evidence.
    HttpApiEndpoint.post("submit", "/workspaces/:ws/repos/:repo/insights/submit", {
      params: { ...ws, repo: Repo },
      payload: Schema.Struct({
        subject: Text.check(Schema.isMinLength(3), Schema.isMaxLength(200)),
        pattern: Text.check(Schema.isMinLength(3), Schema.isMaxLength(2000)),
        suggestion: Text.check(Schema.isMinLength(3), Schema.isMaxLength(2000)),
        citations: Schema.Array(
          Schema.Struct({
            threadId: Text,
            entryId: Text,
            version: Schema.optional(Text),
            quote: Text.check(Schema.isMinLength(3), Schema.isMaxLength(500)),
          }),
        ).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
      }),
      success: Schema.Struct({ finding: Finding, added: Schema.Boolean }),
      error: [Conflict, Forbidden, BackendFailed],
    }),
    // A person's correction to a finding's members, kept with who and why.
    HttpApiEndpoint.post("correct", "/workspaces/:ws/repos/:repo/insights/members", {
      params: { ...ws, repo: Repo },
      payload: Schema.Struct({
        id: Text.check(Schema.isMaxLength(64)),
        add: Schema.Array(Text).check(Schema.isMaxLength(100)),
        remove: Schema.Array(Text).check(Schema.isMaxLength(100)),
        why: Text.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
      }),
      success: Schema.Struct({ finding: Finding }),
      error: [NotFound, Forbidden, BackendFailed],
    }),
    HttpApiEndpoint.post("findings", "/workspaces/:ws/repos/:repo/insights/query", {
      params: { ...ws, repo: Repo },
      payload: Schema.Struct({
        statuses: Schema.optional(Schema.Array(Schema.Literals(FINDING_STATUSES))),
      }),
      success: Schema.Struct({ findings: Schema.Array(Finding) }),
      error: [Forbidden, BackendFailed],
    }),
    // Moves a finding along its lifecycle, recording who, when and why; 409 for a move the
    // lifecycle doesn't allow.
    HttpApiEndpoint.post("transition", "/workspaces/:ws/repos/:repo/insights/transition", {
      params: { ...ws, repo: Repo },
      payload: Schema.Struct({
        id: Text.check(Schema.isMaxLength(64)),
        to: Schema.Literals(FINDING_STATUSES),
        why: Text.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
      }),
      success: Schema.Struct({ finding: Finding }),
      error: [NotFound, Conflict, Forbidden, BackendFailed],
    }),
    // Freezes a review of these commits (core/review.ts): what was shown, at the versions shown.
    HttpApiEndpoint.post("freezeReview", "/workspaces/:ws/repos/:repo/reviews", {
      params: { ...ws, repo: Repo },
      payload: Schema.Struct({
        range: Text.check(Schema.isMaxLength(500)),
        shas: Schema.Array(Sha).check(Schema.isMaxLength(LIMITS.ids)),
        verdict: Schema.Literals(VERDICTS),
        note: Text.check(Schema.isMaxLength(2000)),
      }),
      success: Schema.Struct({ manifest: ReviewManifest }),
      error: [Forbidden, BackendFailed],
    }),
    // A frozen review, exactly as it was, with what each cited session is now.
    HttpApiEndpoint.post("review", "/workspaces/:ws/repos/:repo/reviews/query", {
      params: { ...ws, repo: Repo },
      payload: Schema.Struct({ id: Text.check(Schema.isMaxLength(64)) }),
      success: Schema.Struct({
        manifest: ReviewManifest,
        now: Schema.Array(
          Schema.Struct({ threadId: Schema.String, status: Schema.Literals(EVIDENCE_NOW) }),
        ),
      }),
      error: [NotFound, Forbidden, BackendFailed],
    }),
    // An agent's read-only SQL over the workspace's conversations: every member reads every one.
    // It sees the `agent_threads` and `agent_entries` views and nothing else (AgentSql.ts).
    HttpApiEndpoint.post("sql", "/workspaces/:ws/sql", {
      params: ws,
      payload: Schema.Struct({
        query: Text.check(Schema.isMinLength(1), Schema.isMaxLength(LIMITS.sql)),
      }),
      success: SqlResult,
      error: [QueryRefused, Forbidden, BackendFailed],
    }),
    HttpApiEndpoint.post("commits", "/workspaces/:ws/repos/:repo/commits/query", {
      params: { ...ws, repo: Repo },
      payload: Schema.Struct({ shas: Schema.Array(Sha).check(Schema.isMaxLength(LIMITS.ids)) }),
      success: Schema.Struct({ commits: Schema.Array(CommitRecordV1) }),
      error: [Forbidden, BackendFailed],
    }),
  )
  .middleware(BodyLimit)
  .middleware(Authorization)
  .middleware(ClientVersion)
  .prefix("/v1") {}

export const RepoSummary = Schema.Struct({
  repo: Schema.String,
  commits: Schema.Number,
  threads: Schema.Number,
  latest: Schema.String,
});
export type RepoSummary = typeof RepoSummary.Type;

/** What the webapp reads: repos, a repo's ledger, and Jev's stored answers for blamed hunks. */
export class BrowseApi extends HttpApiGroup.make("browse")
  .add(
    HttpApiEndpoint.get("repos", "/workspaces/:ws/repos", {
      params: ws,
      success: Schema.Struct({ repos: Schema.Array(RepoSummary) }),
      error: BackendFailed,
    }),
    // Linked commits, newest first; `before` is the last SHA of the previous page.
    HttpApiEndpoint.get("ledger", "/workspaces/:ws/repos/:repo/commits", {
      params: { ...ws, repo: Repo },
      query: {
        before: Schema.optional(Text),
        limit: Schema.optional(
          Schema.NumberFromString.check(Schema.isBetween({ minimum: 1, maximum: LIMITS.ledger })),
        ),
      },
      success: Schema.Struct({ commits: Schema.Array(CommitRecordV1) }),
      error: BackendFailed,
    }),
    HttpApiEndpoint.post("blame", "/workspaces/:ws/repos/:repo/blames/query", {
      params: { ...ws, repo: Repo },
      payload: Schema.Struct({ sha: Sha, path: Text, header: Text, model: Text }),
      success: Schema.Struct({ blame: Schema.NullOr(StoredBlame) }),
      error: BackendFailed,
    }),
    HttpApiEndpoint.put("putBlame", "/workspaces/:ws/blames", {
      params: ws,
      payload: StoredBlame,
      success: Schema.Struct({ ok: Schema.Boolean }),
      error: BackendFailed,
    }),
  )
  .middleware(BodyLimit)
  .middleware(Authorization)
  .middleware(ClientVersion)
  .prefix("/v1") {}

export class BackendApi extends HttpApi.make("toolreader-backend")
  .add(SystemApi)
  .add(HistoryApi)
  .add(BrowseApi) {}

const SemVer = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Semver order of two versions (`0.1.9 < 0.2.0-alpha.1 < 0.2.0-beta.1 < 0.2.0`): negative, zero
 * or positive; null when either isn't a version.
 */
export function compareVersions(a: string, b: string): number | null {
  const x = SemVer.exec(a);
  const y = SemVer.exec(b);
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return d;
  }
  // A prerelease sorts before its release; identifiers compare numerically, else as text.
  // ponytail: numbers as JS numbers; exact past 2^53, which no toolreader version reaches.
  if (x[4] === undefined || y[4] === undefined) return (x[4] ? -1 : 0) + (y[4] ? 1 : 0);
  const p = x[4].split(".");
  const q = y[4].split(".");
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    const [m, n] = [p[i]!, q[i]!];
    // Numeric identifiers sort before alphanumeric ones.
    const [mn, nn] = [/^\d+$/.test(m), /^\d+$/.test(n)];
    const d = mn && nn ? Number(m) - Number(n) : mn ? -1 : nn ? 1 : m < n ? -1 : m > n ? 1 : 0;
    if (d !== 0) return d;
  }
  return 0;
}
