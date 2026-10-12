// The checkpoint backend's client (core/backendApi.ts): a `CheckpointSink` over /v1.
// Before its first upload a process checks `GET /v1/meta` (cached an hour in
// ~/.toolreader/cache/meta.json) and stops at "upgrade toolreader" below the backend's minClient.
// What the backend can't take now (unreachable, a timeout, 5xx, 429, a refused token, an old
// client) waits, already redacted, in ~/.toolreader/outbox/, and `flush` sends it first on the
// next run. A record the backend rejects is reported and never retried.
import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import packageJson from "../../../package.json" with { type: "json" };
import {
  BackendApi,
  CLIENT_HEADER,
  compareVersions,
  LIMITS,
  type PutResult,
} from "../../core/backendApi.ts";
import { admitCheckpoint } from "../../core/checkpoint.ts";
import {
  CheckpointFailed,
  CheckpointSink,
  type RewritePair,
  type SendResult,
} from "./Checkpoints.ts";
import { ServerConfig } from "../ServerConfig.ts";

const FileSettings = Schema.Struct({
  backend: Schema.optional(
    Schema.Struct({
      url: Schema.optional(Schema.String),
      token: Schema.optional(Schema.String),
      workspace: Schema.optional(Schema.String),
    }),
  ),
});
const decodeFileSettings = Schema.decodeUnknownEffect(Schema.fromJsonString(FileSettings));

const MetaCache = Schema.Struct({
  url: Schema.String,
  checkedAt: Schema.Number,
  minClient: Schema.String,
});
const decodeMetaCache = Schema.decodeUnknownEffect(Schema.fromJsonString(MetaCache));
const encodeMetaCache = Schema.encodeEffect(Schema.fromJsonString(MetaCache));

const Pair = Schema.Struct({ oldSha: Schema.String, newSha: Schema.String });
/**
 * One outbox file: a record exactly as built (the backend checks it), or a rewrite's pairs, for
 * the backend and workspace it was meant for (never the token).
 */
const Destination = { backend: Schema.String, workspace: Schema.String };
const OutboxEntry = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("checkpoint"),
    ...Destination,
    id: Schema.String,
    replace: Schema.Boolean,
    record: Schema.Unknown,
  }),
  Schema.Struct({
    kind: Schema.Literal("rewrite"),
    ...Destination,
    repo: Schema.String,
    pairs: Schema.Array(Pair),
  }),
]);
type OutboxEntry = typeof OutboxEntry.Type;
const decodeEntry = Schema.decodeUnknownEffect(Schema.fromJsonString(OutboxEntry));
const encodeEntry = Schema.encodeEffect(Schema.fromJsonString(OutboxEntry));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

const META_TTL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT = "30 seconds";

export type BackendSettings = {
  readonly url: string;
  readonly token: Redacted.Redacted<string>;
  readonly workspace: string;
};

/**
 * `backend` in ~/.toolreader/config.json (`url`, `token`, `workspace`), each overridden by
 * TOOLREADER_BACKEND_URL, _TOKEN and _WORKSPACE. Hooks read the file: they may not get the
 * shell's environment. Null without a URL.
 */
export const backendSettings = Effect.fn("BackendClient.settings")(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const file = config.userConfigPath;
  const fromFile = (yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))
    ? ((yield* fs.readFileString(file).pipe(
        Effect.flatMap(decodeFileSettings),
        Effect.mapError((e) => new CheckpointFailed({ message: `${file}: ${e.message}` })),
      )).backend ?? {})
    : {};
  const env = (name: string) =>
    Config.option(Config.string(name)).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
  const url = (yield* env("TOOLREADER_BACKEND_URL")) ?? fromFile.url;
  const token = (yield* env("TOOLREADER_BACKEND_TOKEN")) ?? fromFile.token;
  const workspace = (yield* env("TOOLREADER_BACKEND_WORKSPACE")) ?? fromFile.workspace;
  if (!url) return null;
  const parsed = URL.canParse(url) ? new URL(url) : null;
  if (
    !parsed ||
    !(
      parsed.protocol === "https:" ||
      (parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname))
    )
  )
    return yield* new CheckpointFailed({
      message: `The backend URL must be https:// (http:// only on this machine): ${file}`,
    });
  if (!token || !workspace)
    return yield* new CheckpointFailed({
      message: `A backend URL is set; backend.token and backend.workspace are needed too (${file})`,
    });
  return {
    url: url.replace(/\/+$/, ""),
    token: Redacted.make(token),
    workspace,
  } satisfies BackendSettings;
});

/** Why a request didn't go through, and whether a later run can do better. */
export class SendFailed extends Schema.TaggedErrorClass<SendFailed>()("SendFailed", {
  reason: Schema.String,
  retry: Schema.Boolean,
  /**
   * The backend as a whole can't be reached or won't talk to this client (down, slow, a refused
   * token, an old client): no point sending the rest now. Otherwise this one request got an
   * answer that wasn't the backend's own, and the others may still go.
   */
  wide: Schema.Boolean,
}) {}

/**
 * Sorts a failed request. Only what no later run can fix is final: a request the backend says is
 * too large or unframed (413, 411). Everything else waits in the outbox: the backend unreachable,
 * slow, failing or busy; a refused token or an old client, until someone fixes them; and any
 * answer that isn't the backend's own (a proxy's 404 page, a body this client can't read), which
 * says nothing about the record. For the report and the log, never for spans.
 */
export const classify = (e: unknown): SendFailed => {
  const { _tag, message, minClient, response } = e as {
    _tag?: string;
    message?: string;
    minClient?: string;
    response?: { status: number };
  };
  const retry = (reason: string, wide = true) => new SendFailed({ reason, retry: true, wide });
  const final = (reason: string) => new SendFailed({ reason, retry: false, wide: false });
  switch (_tag) {
    case "SendFailed":
      return e as SendFailed;
    case "UpgradeRequired":
      return retry(`upgrade toolreader to ≥ ${minClient}`);
    case "Unauthorized":
    case "Forbidden":
      return retry(`the backend refused the token: ${message}`);
    case "TimeoutError":
      return retry("the backend did not answer in 30s");
    case "BackendFailed":
      return retry("the backend failed (503)");
    case "TooLarge":
    case "LengthRequired":
      return final(`the backend can't take this request (${_tag})`);
    case "HttpClientError":
      if (response === undefined) return retry(`the backend is unreachable (${message})`);
      if (response.status === 413) return final("the request is too large for the server (413)");
      return retry(
        `the answer wasn't the backend's own (HTTP ${response.status})`,
        response.status >= 500 || response.status === 429,
      );
    case "SchemaError":
      return retry(`the backend's answer doesn't fit this client (${message})`, false);
    default:
      return retry(
        `the backend is unreachable (${_tag ?? "error"}${message ? `: ${message}` : ""})`,
      );
  }
};

/** A plain-HTTP backend only on this machine: the token and records cross no network in clear. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

const fromPut = (r: PutResult): SendResult =>
  r.result === "rejected"
    ? { result: "rejected", detail: `${r.reason}: ${r.detail}` }
    : { result: r.result, detail: null };

/** A `CheckpointSink` that uploads to the backend `settings` names. */
export const BackendSink = (settings: BackendSettings) =>
  Layer.effect(
    CheckpointSink,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = path.join(config.home, ".toolreader");
      const outbox = path.join(dir, "outbox");
      const metaFile = path.join(dir, "cache", "meta.json");
      const api = yield* HttpApiClient.make(BackendApi, {
        baseUrl: settings.url,
        transformClient: HttpClient.mapRequest(
          HttpClientRequest.setHeaders({
            authorization: `Bearer ${Redacted.value(settings.token)}`,
            [CLIENT_HEADER]: packageJson.version,
          }),
        ),
      });
      const ws = { ws: settings.workspace };

      /** Once per process: is this client new enough? From the cache when it is under an hour old. */
      const checkClient = yield* Effect.cached(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const cached = yield* fs
            .readFileString(metaFile)
            .pipe(Effect.flatMap(decodeMetaCache), Effect.option);
          let minClient: string;
          if (
            Option.isSome(cached) &&
            cached.value.url === settings.url &&
            now - cached.value.checkedAt < META_TTL_MS
          ) {
            minClient = cached.value.minClient;
          } else {
            minClient = (yield* api.system.meta().pipe(Effect.timeout(REQUEST_TIMEOUT))).minClient;
            yield* encodeMetaCache({ url: settings.url, checkedAt: now, minClient }).pipe(
              Effect.flatMap((json) =>
                Effect.andThen(
                  fs.makeDirectory(path.dirname(metaFile), { recursive: true, mode: 0o700 }),
                  fs.writeFileString(metaFile, json, { mode: 0o600 }),
                ),
              ),
              Effect.ignore,
            );
          }
          if ((compareVersions(packageJson.version, minClient) ?? 0) < 0)
            return yield* new SendFailed({
              reason: `upgrade toolreader to ≥ ${minClient}`,
              retry: true,
              wide: true,
            });
        }).pipe(
          // Whatever stops the version check says nothing about any record: everything waits.
          Effect.mapError(
            (e) => new SendFailed({ reason: classify(e).reason, retry: true, wide: true }),
          ),
        ),
      );

      /** One request after the version check; fails with why it didn't go through. */
      const request = <A, E>(effect: Effect.Effect<A, E>) =>
        checkClient.pipe(
          Effect.andThen(effect.pipe(Effect.timeout(REQUEST_TIMEOUT), Effect.mapError(classify))),
        );
      const putOnce = (record: unknown, replace: boolean) =>
        request(
          api.checkpoints.put({
            params: ws,
            query: { replace: replace ? "true" : "false" },
            payload: { items: [record] },
          }),
        ).pipe(
          Effect.flatMap(({ results }) =>
            results.length === 1
              ? Effect.succeed(fromPut(results[0]!))
              : Effect.fail(
                  new SendFailed({
                    reason: `the backend answered ${results.length} results for 1 record`,
                    retry: true,
                    wide: false,
                  }),
                ),
          ),
        );
      const rewriteOnce = (repo: string, pairs: ReadonlyArray<RewritePair>) =>
        request(api.checkpoints.rewrite({ params: { ...ws, repo }, payload: { pairs } })).pipe(
          Effect.map(({ added }): SendResult => ({ result: "inserted", detail: `${added} new` })),
        );

      const destination = { backend: settings.url, workspace: settings.workspace };
      /**
       * Written whole to a temp file of its own, then renamed, so a crash or another hook never
       * leaves half a file; readable by you only. One file per record (or rewrite) and backend: a
       * newer copy replaces an older one.
       */
      /** One outbox file per record (or rewrite) and backend. */
      const outboxName = (kind: OutboxEntry["kind"], key: string) =>
        `${NodeCrypto.createHash("sha256")
          .update(`${settings.url}\n${settings.workspace}\n${kind}\n${key}`)
          .digest("hex")}.json`;
      const queue = Effect.fn("BackendClient.queue")(
        function* (entry: OutboxEntry) {
          const name = outboxName(
            entry.kind,
            entry.kind === "checkpoint" ? entry.id : `${entry.repo}\n${encodeJson(entry.pairs)}`,
          );
          yield* fs.makeDirectory(outbox, { recursive: true, mode: 0o700 });
          // A copy queued earlier with --replace keeps asking for it.
          const earlier = yield* fs
            .readFileString(path.join(outbox, name))
            .pipe(Effect.flatMap(decodeEntry), Effect.option);
          const kept =
            entry.kind === "checkpoint" &&
            Option.isSome(earlier) &&
            earlier.value.kind === "checkpoint" &&
            earlier.value.replace
              ? { ...entry, replace: true }
              : entry;
          const tmp = path.join(outbox, `.${name}.${NodeCrypto.randomUUID()}.tmp`);
          yield* fs.writeFileString(tmp, yield* encodeEntry(kept), { mode: 0o600, flag: "wx" });
          yield* fs.rename(tmp, path.join(outbox, name));
        },
        Effect.mapError((e) => new CheckpointFailed({ message: `outbox: ${e.message}` })),
      );
      /** A failure a later run may fix waits in the outbox; any other is reported, once. */
      const queuedOrRejected = (entry: OutboxEntry) => (failure: SendFailed) =>
        failure.retry
          ? Effect.as(queue(entry), {
              result: "queued",
              detail: failure.reason,
            } satisfies SendResult)
          : Effect.succeed<SendResult>({ result: "rejected", detail: failure.reason });

      /**
       * What may leave the machine, checked here first, for new records and queued ones alike: a
       * repo named owner/name, under the size limit, and passing the backend's own checks (so one
       * that isn't fully redacted never leaves). Null when it may go.
       */
      const refusal = (record: unknown, json: string): SendResult | null => {
        const admitted = admitCheckpoint(record);
        if (Result.isFailure(admitted))
          return {
            result: "rejected",
            detail: `${admitted.failure.reason}: ${admitted.failure.detail}`,
          };
        const repo = admitted.success.repo.name;
        if (!repo.includes("/"))
          return {
            result: "rejected",
            detail: `${repo} has no origin remote; the backend names repos owner/name`,
          };
        if (Buffer.byteLength(json) > LIMITS.recordBytes)
          return {
            result: "rejected",
            detail: `too-large: over ${LIMITS.recordBytes} bytes (try --max-output or --no-outputs)`,
          };
        return null;
      };

      const put = Effect.fn("BackendClient.put")(function* (
        checkpoint: Parameters<CheckpointSink["Service"]["put"]>[0],
        options: { readonly replace: boolean },
      ) {
        const json = encodeJson(checkpoint);
        // As JSON has it: a built record leaves optional fields undefined, which JSON drops.
        const record = decodeJson(json);
        const refused = refusal(record, json);
        if (refused) return refused;
        // A copy queued before this upload must not land after it; one queued during it stays.
        const queued = path.join(outbox, outboxName("checkpoint", checkpoint.id));
        const before = yield* fs.readFileString(queued).pipe(Effect.option);
        return yield* putOnce(record, options.replace).pipe(
          Effect.tap(() =>
            Option.isNone(before)
              ? Effect.void
              : fs.readFileString(queued).pipe(
                  Effect.flatMap((now) => (now === before.value ? fs.remove(queued) : Effect.void)),
                  Effect.ignore,
                ),
          ),
          Effect.catch(
            queuedOrRejected({
              kind: "checkpoint",
              ...destination,
              id: checkpoint.id,
              replace: options.replace,
              record,
            }),
          ),
        );
      });

      const rewrite = Effect.fn("BackendClient.rewrite")(function* (
        repo: string,
        pairs: ReadonlyArray<RewritePair>,
      ) {
        return yield* rewriteOnce(repo, pairs).pipe(
          Effect.catch(queuedOrRejected({ kind: "rewrite", ...destination, repo, pairs })),
        );
      });

      /**
       * Sends what earlier runs queued for this backend and workspace, through the same checks as
       * a new record. Stops at the first failure a later run may fix, and says why (`blocked`:
       * "upgrade toolreader", …); one it can't is reported and dropped. A file that isn't JSON moves
       * to `outbox/unreadable/`; one another version or backend queued is left alone (`elsewhere`).
       * Never fails: an outbox it can't read never stops a run.
       */
      const flush = Effect.fn("BackendClient.flush")(function* () {
        const names = yield* fs.readDirectory(outbox).pipe(Effect.orElseSucceed(() => []));
        const sent: Array<SendResult & { readonly id: string }> = [];
        let blocked: string | null = null;
        let elsewhere = 0;
        for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
          const file = path.join(outbox, name);
          const text = yield* fs.readFileString(file).pipe(Effect.result);
          if (Result.isFailure(text)) {
            // Another run sent and removed it already; anything else is reported, and it stays.
            const gone =
              text.failure._tag === "PlatformError" && text.failure.reason._tag === "NotFound";
            if (!gone)
              sent.push({
                id: name,
                result: "queued",
                detail: `can't read it: ${text.failure.message}`,
              });
            continue;
          }
          const json = yield* Effect.try(() => decodeJson(text.success)).pipe(Effect.option);
          if (Option.isNone(json)) {
            const bad = path.join(outbox, "unreadable");
            const moved = yield* fs
              .makeDirectory(bad, { recursive: true, mode: 0o700 })
              .pipe(Effect.andThen(fs.rename(file, path.join(bad, name))), Effect.result);
            sent.push(
              Result.isSuccess(moved)
                ? { id: name, result: "rejected", detail: `not JSON; moved to ${bad}` }
                : {
                    id: name,
                    result: "queued",
                    detail: `not JSON, and stays in the outbox: ${moved.failure.message}`,
                  },
            );
            continue;
          }
          // JSON this version can't read is another version's entry: left for it.
          const decoded = yield* decodeEntry(text.success).pipe(Effect.option);
          if (
            Option.isNone(decoded) ||
            decoded.value.backend !== settings.url ||
            decoded.value.workspace !== settings.workspace
          ) {
            elsewhere++;
            continue;
          }
          if (blocked !== null) continue;
          const entry = decoded.value;
          const id = entry.kind === "checkpoint" ? entry.id : `rewrites of ${entry.repo}`;
          const refused =
            entry.kind === "checkpoint" ? refusal(entry.record, encodeJson(entry.record)) : null;
          const result = refused
            ? Result.succeed(refused)
            : yield* (
                entry.kind === "checkpoint"
                  ? putOnce(entry.record, entry.replace)
                  : rewriteOnce(entry.repo, entry.pairs)
              ).pipe(Effect.result);
          if (Result.isFailure(result) && result.failure.retry) {
            // The backend as a whole: the rest waits too. One request's odd answer: the rest goes.
            if (result.failure.wide) blocked = `${result.failure.reason} (at ${file})`;
            else
              sent.push({
                id,
                result: "queued",
                detail: `${result.failure.reason}; stays in ${file}`,
              });
            continue;
          }
          sent.push(
            Result.isFailure(result)
              ? { id, result: "rejected", detail: result.failure.reason }
              : { id, ...result.success },
          );
          // Unless another run queued a newer copy meanwhile.
          const now = yield* fs.readFileString(file).pipe(Effect.option);
          if (Option.isSome(now) && now.value === text.success)
            yield* fs.remove(file).pipe(Effect.ignore);
        }
        // Counts only, never ids or reasons: an operator sees what the outbox did, not what it held.
        yield* Effect.annotateCurrentSpan({
          "outbox.sent": sent.filter((r) => r.result !== "rejected" && r.result !== "queued")
            .length,
          "outbox.rejected": sent.filter((r) => r.result === "rejected").length,
          "outbox.blocked": blocked !== null,
          "outbox.elsewhere": elsewhere,
        });
        return { sent, blocked, elsewhere };
      });

      return CheckpointSink.of({ put, rewrite, flush });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
