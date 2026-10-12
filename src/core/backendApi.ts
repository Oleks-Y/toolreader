// The checkpoint backend's HTTP contract, v1: shared by the backend
// (src/server/Backend.ts) and its clients. Browser-safe, like api.ts: never put server code here.
// Inside /v1, changes are additive only; a breaking one is /v2, served next to it.
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpApiSecurity from "effect/unstable/httpapi/HttpApiSecurity";

import { Checkpoint, REJECT_REASONS } from "./checkpoint.ts";

export const API_VERSION = 1;
/** Every request names the client's version (package.json's) in this header. */
export const CLIENT_HEADER = "toolreader-client";

export const LIMITS = {
  /** Bytes of one record's JSON; a bigger record is rejected on its own line. */
  recordBytes: 2 * 1024 * 1024,
  /** Bytes of one request's body: 413. */
  requestBytes: 8 * 1024 * 1024,
  /** Records per `put`. */
  items: 100,
  /** Pairs per `rewrite`. */
  pairs: 1000,
  /** Records per read: `forThread` pages through more with `after`; `forCommit` stops here. */
  page: 50,
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

export class NotFound extends Schema.TaggedErrorClass<NotFound>()(
  "NotFound",
  { message: Schema.String },
  { httpApiStatus: 404 },
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

export class UpgradeRequired extends Schema.TaggedErrorClass<UpgradeRequired>()(
  "UpgradeRequired",
  { message: Schema.String, minClient: Schema.String },
  { httpApiStatus: 426 },
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
  formats: Schema.Struct({ checkpoint: Schema.Array(Schema.Number) }),
  features: Schema.Array(Schema.String),
});
export type Meta = typeof Meta.Type;

/**
 * One record's outcome. `exists`: stored with the same content. `differs`: stored with other
 * content, kept (`replace=true` overwrites it, `replaced`). `rejected`: never stored; `detail`
 * names fields and versions, never record text.
 */
export const PutResult = Schema.Union([
  Schema.Struct({
    id: Schema.String,
    result: Schema.Literals(["inserted", "exists", "differs", "replaced"]),
  }),
  Schema.Struct({
    id: Schema.String,
    result: Schema.Literal("rejected"),
    reason: Schema.Literals(REJECT_REASONS),
    detail: Schema.String,
  }),
]);
export type PutResult = typeof PutResult.Type;

export const CommitMatch = Schema.Literals(["sha", "rewrite", "patch-id"]);
export type CommitMatch = typeof CommitMatch.Type;

/** The caller, as its token names it: what `Authorization` gives every handler behind it. */
export class Caller extends Context.Service<
  Caller,
  { readonly workspaceId: string; readonly workspace: string; readonly tokenId: string }
>()("toolreader/core/backendApi/Caller") {}

/** Bearer token → its workspace; 401 without a live token, 403 for another workspace's `:ws`. */
export class Authorization extends HttpApiMiddleware.Service<Authorization, { provides: Caller }>()(
  "toolreader/core/backendApi/Authorization",
  { security: { bearer: HttpApiSecurity.bearer }, error: [Unauthorized, Forbidden, BackendFailed] },
) {}

/** `Toolreader-Client` below the backend's `minClient`, or missing: 426. */
export class ClientVersion extends HttpApiMiddleware.Service<ClientVersion>()(
  "toolreader/core/backendApi/ClientVersion",
  { error: UpgradeRequired },
) {}

/**
 * A body over `LIMITS.requestBytes` (by Content-Length): 413, before it is read. A body without
 * a Content-Length (chunked): 411.
 */
export class BodyLimit extends HttpApiMiddleware.Service<BodyLimit>()(
  "toolreader/core/backendApi/BodyLimit",
  { error: [TooLarge, LengthRequired] },
) {}

export class SystemApi extends HttpApiGroup.make("system")
  .add(
    HttpApiEndpoint.get("health", "/health", { success: Schema.Struct({ ok: Schema.Boolean }) }),
    HttpApiEndpoint.get("meta", "/meta", { success: Meta }).middleware(Authorization),
  )
  .prefix("/v1") {}

/** Path and query text: Postgres text can't hold NUL, which would fail the query (503). */
const Text = Schema.String.check(
  Schema.makeFilter((s: string) => !s.includes("\u0000"), { expected: "text without NUL" }),
);
/** `owner/name`; capped so a rewrite's key fits its index. */
const Repo = Text.check(Schema.isMaxLength(512));
const ws = { ws: Text };
/** A commit id: hex, at most SHA-256 long. */
const Sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{4,64}$/));

export class CheckpointsApi extends HttpApiGroup.make("checkpoints")
  .add(
    // `items` are decoded one by one, so one bad record is its own `rejected` line.
    HttpApiEndpoint.post("put", "/workspaces/:ws/checkpoints", {
      params: ws,
      query: { replace: Schema.optional(Schema.Literals(["true", "false"])) },
      payload: Schema.Struct({
        items: Schema.Array(Schema.Unknown).check(
          Schema.isMinLength(1),
          Schema.isMaxLength(LIMITS.items),
        ),
      }),
      success: Schema.Struct({ results: Schema.Array(PutResult) }),
      error: BackendFailed,
    }),
    HttpApiEndpoint.get("get", "/workspaces/:ws/checkpoints/:id", {
      params: { ...ws, id: Text },
      success: Checkpoint,
      error: [NotFound, BackendFailed],
    }),
    // By SHA, then through recorded rewrites, then by patch-id; strongest first, at most
    // `LIMITS.page` of them.
    HttpApiEndpoint.get("forCommit", "/workspaces/:ws/repos/:repo/commits/:sha/checkpoints", {
      params: { ...ws, repo: Repo, sha: Sha },
      query: { patchId: Schema.optional(Text) },
      success: Schema.Array(Schema.Struct({ checkpoint: Checkpoint, matched: CommitMatch })),
      error: BackendFailed,
    }),
    // Oldest first, a page at a time: `after` is the last id of the page before. A page shorter
    // than `limit` is the last.
    HttpApiEndpoint.get("forThread", "/workspaces/:ws/threads/:threadId/checkpoints", {
      params: { ...ws, threadId: Text },
      query: {
        limit: Schema.optional(
          Schema.FiniteFromString.check(
            Schema.isInt(),
            Schema.isBetween({ minimum: 1, maximum: LIMITS.page }),
          ),
        ),
        after: Schema.optional(Text),
      },
      success: Schema.Array(Checkpoint),
      error: BackendFailed,
    }),
    HttpApiEndpoint.post("rewrite", "/workspaces/:ws/repos/:repo/rewrites", {
      params: { ...ws, repo: Repo },
      payload: Schema.Struct({
        pairs: Schema.Array(Schema.Struct({ oldSha: Sha, newSha: Sha })).check(
          Schema.isMaxLength(LIMITS.pairs),
        ),
      }),
      success: Schema.Struct({ added: Schema.Number }),
      error: BackendFailed,
    }),
  )
  .middleware(BodyLimit)
  .middleware(Authorization)
  .middleware(ClientVersion)
  .prefix("/v1") {}

export class BackendApi extends HttpApi.make("toolreader-backend")
  .add(SystemApi)
  .add(CheckpointsApi) {}

const SemVer = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Semver order of two versions (`0.1.9 < 0.2.0-alpha.1 < 0.2.0-beta.1 < 0.2.0`): negative,
 * zero or positive; null when either isn't a version.
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
