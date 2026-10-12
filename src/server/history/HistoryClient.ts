// The history backend's client: where it is (~/.toolreader/config.json, or the environment) and a
// typed client for its /v1 API (core/historyApi.ts).
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import packageJson from "../../../package.json" with { type: "json" };
import { BackendApi, CLIENT_HEADER, compareVersions } from "../../core/historyApi.ts";
import { ServerConfig } from "../ServerConfig.ts";

export class HistoryFailed extends Schema.TaggedErrorClass<HistoryFailed>()("HistoryFailed", {
  message: Schema.String,
}) {}

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

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type BackendSettings = {
  readonly url: string;
  readonly token: Redacted.Redacted<string>;
  readonly workspace: string;
};

/**
 * `backend` in ~/.toolreader/config.json (`url`, `token`, `workspace`), each overridden by
 * TOOLREADER_BACKEND_URL, _TOKEN and _WORKSPACE. Hooks read the file: they may not get the shell's
 * environment. Plain http only to this machine: the token goes in every request.
 */
export const backendSettings = Effect.fn("HistoryClient.settings")(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const file = config.userConfigPath;
  const fromFile = (yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))
    ? ((yield* fs.readFileString(file).pipe(
        Effect.flatMap(decodeFileSettings),
        Effect.mapError((e) => new HistoryFailed({ message: `${file}: ${e.message}` })),
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
  if (!url || !token || !workspace)
    return yield* new HistoryFailed({
      message: `No history backend: set backend.url, backend.token and backend.workspace in ${file}`,
    });
  const parsed = URL.canParse(url) ? new URL(url) : null;
  if (
    !parsed ||
    !(
      parsed.protocol === "https:" ||
      (parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname))
    )
  )
    return yield* new HistoryFailed({
      message: `The backend URL must be https:// (http:// only on this machine): ${file}`,
    });
  return {
    url: url.replace(/\/+$/, ""),
    token: Redacted.make(token),
    workspace,
  } satisfies BackendSettings;
});

/**
 * The typed client, as this toolreader version, after checking the backend serves it. Every
 * failure is a `HistoryFailed` that says what to do, never a record's text.
 */
export const connect = Effect.fn("HistoryClient.connect")(function* (settings: BackendSettings) {
  const api = yield* HttpApiClient.make(BackendApi, {
    baseUrl: settings.url,
    transformClient: (client) =>
      client.pipe(
        HttpClient.mapRequest(
          HttpClientRequest.setHeaders({
            authorization: `Bearer ${Redacted.value(settings.token)}`,
            [CLIENT_HEADER]: packageJson.version,
          }),
        ),
      ),
  });
  const meta = yield* call(api.system.meta());
  if ((compareVersions(packageJson.version, meta.minClient) ?? -1) < 0)
    return yield* new HistoryFailed({
      message: `The backend serves toolreader ${meta.minClient} or newer: upgrade toolreader`,
    });
  return api;
});

/** One request, bounded (a thread's history can take a while to send), its failure reported. */
export const call = <A, E extends { readonly _tag: string; readonly message?: string }, R>(
  request: Effect.Effect<A, E, R>,
) => request.pipe(Effect.timeout("120 seconds"), Effect.mapError(asFailed));

/** A request's failure, as the CLI reports it. */
export const asFailed = (e: { readonly _tag: string; readonly message?: string }) =>
  new HistoryFailed({
    message:
      e._tag === "Rejected"
        ? `rejected (${(e as { reason?: string }).reason}): ${(e as { detail?: string }).detail}`
        : `${e._tag}${e.message ? `: ${e.message}` : ""}`,
  });
