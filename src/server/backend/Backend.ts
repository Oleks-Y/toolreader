// The checkpoint backend (core/backendApi.ts): owns Postgres and its
// migrations, and stores the records clients send, one workspace per token. Every record is
// checked again here (`admitCheckpoint`: format, schema, key, redaction), so a client bug can't
// store what the CLI would never write. `toolreader backend serve` runs it (backendCli.ts).
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
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
  NotFound,
  TooLarge,
  Unauthorized,
  UpgradeRequired,
  type PutResult,
} from "../../core/backendApi.ts";
import {
  admitCheckpoint,
  CHECKPOINT_FORMAT_VERSION,
  REJECT_REASONS,
} from "../../core/checkpoint.ts";
import { CheckpointStore, type WorkspaceStore } from "./CheckpointStore.ts";

/**
 * The oldest client this backend serves. ponytail: a constant; raise it in the release that
 * stops serving older clients.
 */
export const MIN_CLIENT = "0.1.0";

/**
 * The store failed. Its message stays here: a stored record that fails to read is described by a
 * schema issue, which can quote the record. The span keeps the error's tag.
 */
const failed = () => new BackendFailed({ message: "The checkpoint database failed; retry later" });

const RecordId = Schema.Struct({ id: Schema.String });
const decodeRecordId = Schema.decodeUnknownOption(RecordId);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const AuthorizationLive = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const store = yield* CheckpointStore;
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

/**
 * The upload span's attributes: how many records got each result and each rejection reason,
 * zeros included, so rates and error ratios come from spans (NFR-O4). Counts only, never ids.
 */
export const putCounts = (results: ReadonlyArray<PutResult>): Record<string, number> => {
  const counts: Record<string, number> = { items: results.length };
  for (const r of ["inserted", "exists", "differs", "replaced", "rejected"])
    counts[`result.${r}`] = 0;
  for (const reason of REJECT_REASONS) counts[`rejected.${reason}`] = 0;
  for (const r of results) {
    counts[`result.${r.result}`]!++;
    if (r.result === "rejected") counts[`rejected.${r.reason}`]!++;
  }
  return counts;
};

/** One record: checked, then stored. A record that fails a check is its own `rejected` line. */
const putOne = Effect.fn("Backend.putOne")(function* (
  store: WorkspaceStore,
  item: unknown,
  replace: boolean,
) {
  const id = Option.match(decodeRecordId(item), { onNone: () => "", onSome: (r) => r.id });
  const bytes = Buffer.byteLength(encodeJson(item));
  if (bytes > LIMITS.recordBytes)
    return {
      id,
      result: "rejected",
      reason: "too-large",
      detail: `${bytes} bytes; a record takes at most ${LIMITS.recordBytes}`,
    } satisfies PutResult;
  const admitted = admitCheckpoint(item);
  if (Result.isFailure(admitted))
    return { id, result: "rejected", ...admitted.failure } satisfies PutResult;
  // A check `admitCheckpoint` doesn't know of: storing it again can't succeed either.
  return yield* store.put(admitted.success, { replace }).pipe(
    Effect.map((result): PutResult => ({ id, result })),
    Effect.catchTag("CheckpointRefused", () =>
      Effect.succeed<PutResult>({
        id,
        result: "rejected",
        reason: "invalid",
        detail: "the database refused the record's data",
      }),
    ),
  );
});

const SystemHandlers = HttpApiBuilder.group(BackendApi, "system", (handlers) =>
  handlers
    .handle("health", () => Effect.succeed({ ok: true }))
    .handle("meta", () =>
      Effect.succeed({
        server: packageJson.version,
        apiVersion: API_VERSION,
        minClient: MIN_CLIENT,
        formats: { checkpoint: [CHECKPOINT_FORMAT_VERSION] },
        features: [],
      }),
    ),
);

const CheckpointsHandlers = HttpApiBuilder.group(
  BackendApi,
  "checkpoints",
  Effect.fn(function* (handlers) {
    const pg = yield* CheckpointStore;
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
    const upload = Effect.fn("Backend.put")(function* (
      items: ReadonlyArray<unknown>,
      replace: boolean,
    ) {
      const store = yield* scoped;
      // Counted as they come, so a batch the database fails partway still reports what it did.
      const results: PutResult[] = [];
      yield* Effect.forEach(items, (item) =>
        Effect.map(putOne(store, item, replace), (r) => results.push(r)),
      ).pipe(Effect.ensuring(Effect.suspend(() => Effect.annotateCurrentSpan(putCounts(results)))));
      return { results };
    }, Effect.mapError(failed));
    return handlers
      .handle("put", ({ payload, query }) => upload(payload.items, query.replace === "true"))
      .handle("get", ({ params }) =>
        Effect.gen(function* () {
          const found = yield* Effect.flatMap(scoped, (s) => s.get(params.id)).pipe(
            Effect.mapError(failed),
          );
          if (Option.isNone(found))
            return yield* new NotFound({ message: "No such checkpoint in this workspace" });
          return found.value;
        }),
      )
      .handle("forCommit", ({ params, query }) =>
        Effect.flatMap(scoped, (s) =>
          s.forCommit(params.repo, params.sha, query.patchId ?? null),
        ).pipe(Effect.mapError(failed)),
      )
      .handle("forThread", ({ params, query }) =>
        Effect.flatMap(scoped, (s) =>
          s.forThread(params.threadId, {
            ...(query.limit === undefined ? {} : { limit: query.limit }),
            ...(query.after === undefined ? {} : { after: query.after }),
          }),
        ).pipe(Effect.mapError(failed)),
      )
      .handle("rewrite", ({ params, payload }) =>
        Effect.flatMap(scoped, (s) => s.rewrite(params.repo, payload.pairs)).pipe(
          Effect.map((added) => ({ added })),
          Effect.mapError(failed),
        ),
      );
  }),
);

/** The API's routes, needing only the store: tests serve them on a test server. */
export const BackendRoutes = HttpApiBuilder.layer(BackendApi).pipe(
  Layer.provide([SystemHandlers, CheckpointsHandlers]),
  Layer.provide([AuthorizationLive, ClientVersionLive, BodyLimitLive]),
);

/**
 * Serves the backend on 127.0.0.1:`port`. Checkpoint ids and thread ids run long (T3 V2 names
 * subagent threads after their parent's ids); the router's default refuses params over 100
 * characters.
 */
export const BackendServerLive = (port: number) =>
  // No request log: Effect's logs each URL, which names repos and threads. Each request's span
  // has its route, status and duration instead (NFR-O4).
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
