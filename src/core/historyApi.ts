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

import { CommitRecordV1, REJECT_REASONS, REPO_MAX, ThreadRecordV1 } from "./historyRecord.ts";

export const API_VERSION = 1;
/** Every request names the client's version (package.json's) in this header. */
export const CLIENT_HEADER = "toolreader-client";

export const LIMITS = {
  /** Bytes of one request's body (one thread's whole history, outputs clipped): 413. */
  requestBytes: 64 * 1024 * 1024,
  /** Ids per `hashes`, SHAs per `commits`. */
  ids: 500,
  /**
   * Whole threads per `threads` read: each can be tens of MB. ponytail: a count, not a byte budget;
   * page by bytes if threads grow past ~50 MB.
   */
  threads: 10,
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

export class BackendApi extends HttpApi.make("toolreader-backend").add(SystemApi).add(HistoryApi) {}

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
