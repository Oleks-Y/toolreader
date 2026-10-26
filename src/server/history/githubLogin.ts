// `toolreader history login`: a person signs in with GitHub (its device flow, through the client id
// the backend names), and the token goes to ~/.toolreader/config.json as `backend.githubToken`,
// next to any workspace token the hooks sync with. Reads and decisions then go as that person.
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { HistoryFailed } from "./HistoryClient.ts";

const DeviceCode = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  expires_in: Schema.Number,
  interval: Schema.Number,
});
const decodeDeviceCode = Schema.decodeUnknownEffect(DeviceCode);
const TokenAnswer = Schema.Struct({
  access_token: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  interval: Schema.optional(Schema.Number),
});
const decodeTokenAnswer = Schema.decodeUnknownEffect(TokenAnswer);
const JsonText = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownEffect(JsonText);
const encodeJson = Schema.encodeEffect(JsonText);

/**
 * GitHub's device flow: `show` tells the person where to go and what to type, then this waits
 * for them (at GitHub's pace) and returns their token.
 */
export const deviceLogin = Effect.fn("githubLogin.deviceLogin")(function* (
  webUrl: string,
  clientId: string,
  show: (uri: string, code: string) => Effect.Effect<void>,
) {
  const http = yield* HttpClient.HttpClient;
  const post = (path: string, form: Record<string, string>) =>
    http
      .execute(
        HttpClientRequest.post(`${webUrl}${path}`).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bodyUrlParams(form),
        ),
      )
      .pipe(
        Effect.flatMap((r) => r.json),
        Effect.mapError(() => new HistoryFailed({ message: `GitHub (${webUrl}) didn't answer` })),
      );
  const unexpected = () => new HistoryFailed({ message: "GitHub's answer wasn't a device login" });
  const code = yield* post("/login/device/code", { client_id: clientId }).pipe(
    Effect.flatMap(decodeDeviceCode),
    Effect.mapError((e) => (e._tag === "HistoryFailed" ? e : unexpected())),
  );
  yield* show(code.verification_uri, code.user_code);
  let interval = code.interval;
  const deadline = (yield* Clock.currentTimeMillis) + code.expires_in * 1000;
  while ((yield* Clock.currentTimeMillis) < deadline) {
    yield* Effect.sleep(Duration.seconds(interval));
    const answer = yield* post("/login/oauth/access_token", {
      client_id: clientId,
      device_code: code.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).pipe(
      Effect.flatMap(decodeTokenAnswer),
      Effect.mapError((e) => (e._tag === "HistoryFailed" ? e : unexpected())),
    );
    if (answer.access_token) return answer.access_token;
    if (answer.error === "authorization_pending") continue;
    if (answer.error === "slow_down") {
      interval = answer.interval ?? interval + 5;
      continue;
    }
    return yield* new HistoryFailed({
      message:
        answer.error === "access_denied"
          ? "Sign-in was cancelled on GitHub"
          : `GitHub refused the sign-in (${answer.error ?? "no reason given"})`,
    });
  }
  return yield* new HistoryFailed({ message: "The sign-in code expired: run history login again" });
});

/** Keeps `token` as `backend.githubToken` in the config file, readable by its owner only. */
export const saveGithubToken = Effect.fn("githubLogin.save")(function* (
  file: string,
  token: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const current = (yield* fs.exists(file))
    ? yield* fs.readFileString(file).pipe(
        Effect.flatMap(decodeJson),
        Effect.mapError(() => new HistoryFailed({ message: `${file} isn't JSON` })),
      )
    : {};
  if (!Predicate.isObject(current))
    return yield* new HistoryFailed({ message: `${file} isn't a JSON object` });
  const backend = Predicate.isObject(current["backend"]) ? current["backend"] : {};
  const text = yield* encodeJson({ ...current, backend: { ...backend, githubToken: token } }).pipe(
    Effect.mapError(() => new HistoryFailed({ message: "Couldn't write the config" })),
  );
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(file, `${text}\n`, { mode: 0o600 });
  yield* fs.chmod(file, 0o600);
});
