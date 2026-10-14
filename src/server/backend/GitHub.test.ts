// The GitHub service against answers shaped like GitHub's, from a fake HTTP client: never GitHub.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { GitHub } from "./GitHub.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const seen: string[] = [];
/** GitHub as alex's token sees it: alex, who can read acme/app and nothing else. */
const FakeGitHub = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) => {
    seen.push(request.url);
    const alex = request.headers["authorization"] === "Bearer gho_alex";
    const [status, body] = !alex
      ? [401, { message: "Bad credentials" }]
      : request.url.endsWith("/user")
        ? [200, { login: "Alex", id: 1 }]
        : request.url.endsWith("/repos/acme/app")
          ? [200, { full_name: "acme/app", permissions: { pull: true } }]
          : [404, { message: "Not Found" }];
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response(encodeJson(body), { status })),
    );
  }),
);

const layer = GitHub.layer({
  clientId: "Iv1.test",
  apiUrl: "https://api.github.test",
  webUrl: "https://github.test",
}).pipe(Layer.provide(FakeGitHub));

describe("GitHub", () => {
  it.effect("names the token's user, and asks GitHub whether they can read a repo", () =>
    Effect.gen(function* () {
      const github = yield* GitHub;
      assert.deepStrictEqual(yield* github.user("gho_alex"), Option.some("alex"));
      assert.deepStrictEqual(yield* github.user("gho_wrong"), Option.none());
      assert.isTrue(yield* github.canRead("gho_alex", "acme/app"));
      assert.isFalse(yield* github.canRead("gho_alex", "acme/secret"));
      // Never a URL built from something that isn't owner/name.
      const before = seen.length;
      assert.isFalse(yield* github.canRead("gho_alex", "acme/app/../../user"));
      assert.isFalse(yield* github.canRead("gho_alex", "acme/app?x=1"));
      assert.strictEqual(seen.length, before);
      // Answers are cached: asking again doesn't ask GitHub again.
      yield* github.canRead("gho_alex", "acme/app");
      assert.strictEqual(seen.length, before);
    }).pipe(Effect.provide(layer)),
  );
});
