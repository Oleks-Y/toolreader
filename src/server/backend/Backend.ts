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
import { GitHub } from "./GitHub.ts";
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

/** Workspace tokens are ours; any other bearer is tried as a GitHub sign-in. */
const WORKSPACE_TOKEN = "trk_";

/**
 * A workspace token for its workspace, or a GitHub sign-in for a workspace that lists the login
 * as a member. What a sign-in may read is checked per repo (`readable`).
 */
export const AuthorizationLive = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const store = yield* HistoryStore;
    const github = yield* GitHub;
    const signedIn = Effect.fn("Backend.signedIn")(function* (
      token: string,
      ws: string | undefined,
    ) {
      const login = yield* github.user(token).pipe(Effect.mapError(failed));
      if (Option.isNone(login))
        return yield* new Unauthorized({ message: "GitHub doesn't accept this sign-in" });
      // Outside a workspace (meta) there's nothing to read: who they are is enough.
      if (ws === undefined)
        return {
          workspaceId: "",
          workspace: "",
          tokenId: null,
          github: { login: login.value, token },
        };
      const member = yield* store.member(ws, login.value).pipe(Effect.mapError(failed));
      if (Option.isNone(member))
        return yield* new Forbidden({
          message: `${login.value} is not a member of workspace ${ws}`,
        });
      return {
        workspaceId: member.value.workspaceId,
        workspace: ws,
        tokenId: null,
        github: { login: login.value, token },
      };
    });
    return Authorization.of({
      bearer: Effect.fn("Backend.authorize")(function* (
        handler: Effect.Effect<HttpServerResponse.HttpServerResponse, unhandled, Caller>,
        { credential }: { readonly credential: Redacted.Redacted<string> },
      ) {
        const token = Redacted.value(credential);
        const { ws } = yield* HttpRouter.params;
        if (token !== "" && !token.startsWith(WORKSPACE_TOKEN) && github.config) {
          const caller = yield* signedIn(token, ws);
          yield* Effect.annotateCurrentSpan("workspace", caller.workspace);
          return yield* Effect.provideService(handler, Caller, caller);
        }
        const caller =
          token === ""
            ? Option.none()
            : yield* store.authenticate(token).pipe(Effect.mapError(failed));
        if (Option.isNone(caller))
          return yield* new Unauthorized({ message: "Missing, unknown or revoked token" });
        if (ws !== undefined && ws !== caller.value.workspace)
          return yield* new Forbidden({ message: `This token is not for workspace ${ws}` });
        yield* Effect.annotateCurrentSpan("workspace", caller.value.workspace);
        return yield* Effect.provideService(handler, Caller, { ...caller.value, github: null });
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
    .handle("signIn", () =>
      Effect.map(GitHub, (g) => ({
        github: g.config ? { clientId: g.config.clientId, webUrl: g.config.webUrl } : null,
      })),
    )
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
    const github = yield* GitHub;
    /** The caller's workspace, written as the caller (its token or login, and client version). */
    const scoped = Effect.gen(function* () {
      const caller = yield* Caller;
      const request = yield* HttpServerRequest.HttpServerRequest;
      return pg.at({
        workspaceId: caller.workspaceId,
        tokenId: caller.tokenId,
        client: request.headers[CLIENT_HEADER] ?? "",
        actor: caller.github ? `github:${caller.github.login}` : undefined,
      });
    });
    /** Writing history is for machines with a workspace token, not a person's sign-in. */
    const writer = Effect.gen(function* () {
      if ((yield* Caller).github)
        return yield* new Forbidden({
          message: "A GitHub sign-in reads and decides; sync with a workspace token",
        });
    });
    /** A sign-in reads only repos GitHub says it can; a workspace token reads its workspace. */
    const readable = (repo: string | undefined) =>
      Effect.gen(function* () {
        const { github: signIn } = yield* Caller;
        if (!signIn) return;
        if (repo === undefined)
          return yield* new Forbidden({ message: "A GitHub sign-in names the repo it reads" });
        const ok = yield* github.canRead(signIn.token, repo).pipe(Effect.mapError(failed));
        if (!ok)
          return yield* new Forbidden({
            message: `GitHub says ${signIn.login} can't read ${repo}`,
          });
      });
    return handlers
      .handle("hashes", ({ payload }) =>
        writer.pipe(
          Effect.andThen(Effect.flatMap(scoped, (s) => s.hashes(payload.ids))),
          Effect.map((found) => ({ hashes: Object.fromEntries(found) })),
          Effect.catchTag("HistoryStoreFailed", () => Effect.fail(failed())),
        ),
      )
      .handle("putThread", ({ payload }) =>
        Effect.gen(function* () {
          yield* writer;
          const record = yield* admitted(admitThread(payload));
          const store = yield* scoped;
          return { result: yield* store.putThread(record).pipe(Effect.mapError(putFailed)) };
        }),
      )
      .handle("threads", ({ payload }) =>
        Effect.gen(function* () {
          yield* readable(payload.repo);
          const store = yield* scoped;
          const threads = yield* store
            .threads(payload.ids, payload.repo)
            .pipe(Effect.mapError(failed));
          return { threads };
        }),
      )
      .handle("putCommit", ({ payload }) =>
        Effect.gen(function* () {
          yield* writer;
          const record = yield* admitted(admitCommit(payload));
          const store = yield* scoped;
          return { result: yield* store.putCommit(record).pipe(Effect.mapError(putFailed)) };
        }),
      )
      .handle("evidence", ({ payload }) =>
        Effect.gen(function* () {
          const caller = yield* Caller;
          if (caller.github) {
            // A sign-in reads only what's linked to a repo GitHub lets it read: else withheld.
            if (!payload.repo) return { status: "withheld" as const };
            const ok = yield* github
              .canRead(caller.github.token, payload.repo)
              .pipe(Effect.mapError(failed));
            if (!ok) return { status: "withheld" as const };
          }
          const store = yield* scoped;
          return yield* store.evidence(payload).pipe(Effect.mapError(failed));
        }),
      )
      .handle("commits", ({ params, payload }) =>
        readable(params.repo).pipe(
          Effect.andThen(Effect.flatMap(scoped, (s) => s.commits(params.repo, payload.shas))),
          Effect.map((commits) => ({ commits })),
          Effect.catchTag("HistoryStoreFailed", () => Effect.fail(failed())),
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
