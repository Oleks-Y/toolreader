import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import { BlameFailed } from "../core/api.ts";
import { handleBlameRequest } from "./http.ts";

it.effect("blocks absent and cross-site origins before blame side effects", () =>
  Effect.gen(function* () {
    let calls = 0;
    const blame = {
      line: () => {
        calls++;
        return Effect.fail(new BlameFailed({ message: "fake provider called" }));
      },
    };
    for (const origin of [null, "https://attacker.example", "http://127.0.0.1:4777"]) {
      const headers: Record<string, string> = { host: "127.0.0.1:4777" };
      if (origin) headers.origin = origin;
      const result = yield* handleBlameRequest({ url: "fake", sendsSessionText: true }, blame).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request("http://127.0.0.1:4777/api/blame", { method: "POST", headers }),
          ),
        ),
        Effect.flip,
      );
      assert.strictEqual(
        result.message,
        origin === "http://127.0.0.1:4777"
          ? "fake provider called"
          : "Blame requires a same-origin request",
      );
    }
    assert.strictEqual(calls, 1);
  }),
);
