// The history backend (core/historyApi.ts): owns Postgres and its migrations, and stores the
// threads and commit links clients send, one workspace per token. Every record is checked again
// here (`admitThread`/`admitCommit`: format, schema, redaction), so a client bug can't store what
// the CLI would never send. `toolreader backend serve` runs it (backendCli.ts).
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import type { unhandled } from "effect/Types";

import packageJson from "../../../package.json" with { type: "json" };
import {
  API_VERSION,
  Authorization,
  BackendApi,
  BackendFailed,
  BodyLimit,
  Caller,
  CLIENT_HEADER,
  ClientVersion,
  compareVersions,
  Forbidden,
  LengthRequired,
  LIMITS,
  Rejected,
  TooLarge,
  Unauthorized,
  UpgradeRequired,
} from "../../core/historyApi.ts";
import {
  admitCommit,
  admitThread,
  HISTORY_FORMAT_VERSION,
  type Rejection,
} from "../../core/historyRecord.ts";
import { HistoryStore, type HistoryRefused, type HistoryStoreFailed } from "./HistoryStore.ts";

/**
 * The oldest client this backend serves. ponytail: a constant; raise it in the release that stops
 * serving older clients.
 */
export const MIN_CLIENT = "0.1.0";

/**
 * The store failed. Its message stays here: a stored record that fails to read is described by a
 * schema issue, which can quote the record. The span keeps the error's tag.
 */
const failed = () => new BackendFailed({ message: "The history database failed; retry later" });

/** A record Postgres refuses can't be stored by trying again either: a 422, not a 503. */
const putFailed = (e: HistoryStoreFailed | HistoryRefused) =>
  e._tag === "HistoryRefused"
    ? new Rejected({ reason: "invalid", detail: "the database refused the record's data" })
    : failed();

export const AuthorizationLive = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const store = yield* HistoryStore;
    return Authorization.of({
      bearer: Effect.fn("Backend.authorize")(function* (
        handler: Effect.Effect<HttpServerResponse.HttpServerResponse, unhandled, Caller>,
        { credential }: { readonly credential: Redacted.Redacted<string> },
      ) {
        const token = Redacted.value(credential);
        const caller =
          token === ""
            ? Option.none()
            : yield* store.authenticate(token).pipe(Effect.mapError(failed));
        if (Option.isNone(caller))
          return yield* new Unauthorized({ message: "Missing, unknown or revoked token" });
        const { ws } = yield* HttpRouter.params;
        if (ws !== undefined && ws !== caller.value.workspace)
          return yield* new Forbidden({ message: `This token is not for workspace ${ws}` });
        yield* Effect.annotateCurrentSpan("workspace", caller.value.workspace);
        return yield* Effect.provideService(handler, Caller, caller.value);
      }),
    });
  }),
);

export const ClientVersionLive = Layer.succeed(
  ClientVersion,
  Effect.fn("Backend.clientVersion")(function* (
    handler: Effect.Effect<HttpServerResponse.HttpServerResponse, unhandled>,
  ) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const client = request.headers[CLIENT_HEADER];
    const order = client === undefined ? null : compareVersions(client, MIN_CLIENT);
    if (order === null || order < 0)
      return yield* new UpgradeRequired({
        message: `This backend serves toolreader ${MIN_CLIENT} or newer: upgrade toolreader`,
        minClient: MIN_CLIENT,
      });
    return yield* handler;
  }),
);

/**
 * A body must say its length, so the limit holds before reading it: Node reads exactly
 * Content-Length bytes. A body streamed without one (chunked) is refused with 411.
 */
export const BodyLimitLive = Layer.succeed(
  BodyLimit,
  Effect.fn("Backend.bodyLimit")(function* (
    handler: Effect.Effect<HttpServerResponse.HttpServerResponse, unhandled>,
  ) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const length = request.headers["content-length"];
    if (length === undefined && request.headers["transfer-encoding"] !== undefined)
      return yield* new LengthRequired({ message: "Send the body with a Content-Length" });
    if (Number(length ?? 0) > LIMITS.requestBytes)
      return yield* new TooLarge({
        message: `A request takes at most ${LIMITS.requestBytes} bytes`,
        maxBytes: LIMITS.requestBytes,
      });
    return yield* handler;
  }),
);

/** A record `admit` takes, else the 422 that says why. */
const admitted = <A>(r: Result.Result<A, Rejection>) =>
  Result.match(r, {
    onSuccess: Effect.succeed,
    onFailure: (rejection) => Effect.fail(new Rejected(rejection)),
  });

const SystemHandlers = HttpApiBuilder.group(BackendApi, "system", (handlers) =>
  handlers
    .handle("health", () => Effect.succeed({ ok: true }))
    .handle("meta", () =>
      Effect.succeed({
        server: packageJson.version,
        apiVersion: API_VERSION,
        minClient: MIN_CLIENT,
        formats: [HISTORY_FORMAT_VERSION],
      }),
    ),
);

const HistoryHandlers = HttpApiBuilder.group(
  BackendApi,
  "history",
  Effect.fn(function* (handlers) {
    const pg = yield* HistoryStore;
    /** The caller's workspace, written as the caller (its token and client version). */
    const scoped = Effect.gen(function* () {
      const caller = yield* Caller;
      const request = yield* HttpServerRequest.HttpServerRequest;
      return pg.at({
        workspaceId: caller.workspaceId,
        tokenId: caller.tokenId,
        client: request.headers[CLIENT_HEADER] ?? "",
      });
    });
    return handlers
      .handle("hashes", ({ payload }) =>
        Effect.flatMap(scoped, (s) => s.hashes(payload.ids)).pipe(
          Effect.map((found) => ({ hashes: Object.fromEntries(found) })),
          Effect.mapError(failed),
        ),
      )
      .handle("putThread", ({ payload }) =>
        Effect.gen(function* () {
          const record = yield* admitted(admitThread(payload));
          const store = yield* scoped;
          return { result: yield* store.putThread(record).pipe(Effect.mapError(putFailed)) };
        }),
      )
      .handle("threads", ({ payload }) =>
        Effect.flatMap(scoped, (s) => s.threads(payload.ids)).pipe(
          Effect.map((threads) => ({ threads })),
          Effect.mapError(failed),
        ),
      )
      .handle("putCommit", ({ payload }) =>
        Effect.gen(function* () {
          const record = yield* admitted(admitCommit(payload));
          const store = yield* scoped;
          return { result: yield* store.putCommit(record).pipe(Effect.mapError(putFailed)) };
        }),
      )
      .handle("search", ({ payload }) =>
        Effect.flatMap(scoped, (s) =>
          s.search({ text: payload.text, repo: payload.repo, limit: payload.limit ?? 20 }),
        ).pipe(Effect.mapError(failed)),
      )
      .handle("commits", ({ params, payload }) =>
        Effect.flatMap(scoped, (s) => s.commits(params.repo, payload.shas)).pipe(
          Effect.map((commits) => ({ commits })),
          Effect.mapError(failed),
        ),
      );
  }),
);

/** The API's routes, needing only the store: tests serve them on a test server. */
export const BackendRoutes = HttpApiBuilder.layer(BackendApi).pipe(
  Layer.provide([SystemHandlers, HistoryHandlers]),
  Layer.provide([AuthorizationLive, ClientVersionLive, BodyLimitLive]),
);

/**
 * Serves the backend on 127.0.0.1:`port`. Thread ids run long (T3 V2 names subagent threads after
 * their parent's ids); the router's default refuses params over 100 characters.
 */
export const BackendServerLive = (port: number) =>
  // No request log: Effect's logs each URL, which names repos. Each request's span has its route,
  // status and duration instead.
  HttpRouter.serve(BackendRoutes, {
    disableLogger: true,
    routerConfig: { maxParamLength: 2048 },
  }).pipe(
    Layer.provide(
      Layer.unwrap(
        Effect.promise(() => import("node:http")).pipe(
          Effect.map((NodeHttp) =>
            NodeHttpServer.layer(NodeHttp.createServer, { port, host: "127.0.0.1" }),
          ),
        ),
      ),
    ),
  );
