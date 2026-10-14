// The device flow against answers shaped like GitHub's, from a fake HTTP client: never GitHub.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { deviceLogin, saveGithubToken } from "./githubLogin.ts";

const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** GitHub answering the token poll with each of `answers` in turn. */
const github = (answers: ReadonlyArray<object>) => {
  let poll = 0;
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const body = request.url.endsWith("/login/device/code")
        ? {
            device_code: "dev",
            user_code: "ABCD-1234",
            verification_uri: "https://github.test/login/device",
            expires_in: 900,
            interval: 0,
          }
        : answers[Math.min(poll++, answers.length - 1)];
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(encodeJson(body), { status: 200 })),
      );
    }),
  );
};

describe("history login", () => {
  it.live("shows the code, waits while the person approves, and returns their token", () =>
    Effect.gen(function* () {
      const shown: string[] = [];
      const token = yield* deviceLogin("https://github.test", "Iv1.test", (uri, code) =>
        Effect.sync(() => void shown.push(`${uri} ${code}`)),
      ).pipe(
        Effect.provide(
          github([
            { error: "authorization_pending" },
            { error: "authorization_pending" },
            { access_token: "gho_x" },
          ]),
        ),
      );
      assert.strictEqual(token, "gho_x");
      assert.deepStrictEqual(shown, ["https://github.test/login/device ABCD-1234"]);
    }),
  );

  it.live("says so when the person cancels on GitHub", () =>
    Effect.gen(function* () {
      const failed = yield* deviceLogin("https://github.test", "Iv1.test", () => Effect.void).pipe(
        Effect.provide(github([{ error: "access_denied" }])),
        Effect.flip,
      );
      assert.strictEqual(failed.message, "Sign-in was cancelled on GitHub");
    }),
  );

  it.live("keeps the token next to the workspace settings, readable by its owner only", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "toolreader-login-" });
      const file = `${dir}/.toolreader/config.json`;
      yield* fs.makeDirectory(`${dir}/.toolreader`);
      yield* fs.writeFileString(
        file,
        '{"backend":{"url":"https://h.test","token":"trk_a","workspace":"acme"},"other":1}',
      );
      yield* saveGithubToken(file, "gho_x");
      assert.deepStrictEqual(decodeJson(yield* fs.readFileString(file)), {
        backend: { url: "https://h.test", token: "trk_a", workspace: "acme", githubToken: "gho_x" },
        other: 1,
      });
      assert.strictEqual((yield* fs.stat(file)).mode & 0o777, 0o600);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
