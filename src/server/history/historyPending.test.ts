// Ranges a hook couldn't sync, waiting for the next hook in the same repository, and what
// `history status` and `history remind` make of them.
import * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../ServerConfig.ts";
import { deliveryStatus, statusLines } from "./historyCli.ts";
import { deliveryLine, deliveryOf, deliveryWarning, pending } from "./historyHooks.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const configAt = (home: string, userConfigPath = "") =>
  Layer.succeed(
    ServerConfig,
    ServerConfig.of({
      port: 0,
      home,
      dbPath: "",
      codexBin: "codex",
      codexHome: "",
      claudeHome: "",
      labelsPath: "",
      userConfigPath,
      distDir: "",
    }),
  );

describe("pending syncs", () => {
  it.effect("keeps every range two hooks add at once, per repository, until it's done", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "toolreader-pending-" });
      yield* Effect.gen(function* () {
        const a = yield* pending("/repos/a/.git");
        const b = yield* pending("/repos/b/.git");
        yield* Effect.all(
          [a.failed("x1..x2", "X"), a.failed("y1..y2", "X"), b.failed("z1..z2", "X")],
          { concurrency: "unbounded" },
        );
        assert.deepStrictEqual((yield* a.list).map((p) => p.range).sort(), ["x1..x2", "y1..y2"]);
        yield* a.done("x1..x2");
        assert.deepStrictEqual(
          (yield* a.list).map((p) => p.range),
          ["y1..y2"],
        );
        assert.deepStrictEqual(
          (yield* b.list).map((p) => p.range),
          ["z1..z2"],
        );
        const [file] = yield* fs.readDirectory(`${home}/.toolreader/pending`);
        assert.strictEqual(
          (yield* fs.stat(`${home}/.toolreader/pending/${file}`)).mode & 0o777,
          0o600,
        );
      }).pipe(Effect.provide(configAt(home)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "records when a range first failed, its last attempt and why; old files still read",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "toolreader-pending-" });
        yield* Effect.gen(function* () {
          // As a hook before this one wrote it: no times, no error.
          yield* fs.makeDirectory(`${home}/.toolreader/pending`, { recursive: true });
          yield* fs.writeFileString(
            `${home}/.toolreader/pending/legacy.json`,
            encodeJson({ repo: "/repos/a/.git", range: "old1..old2" }),
          );
          const a = yield* pending("/repos/a/.git");
          assert.deepStrictEqual(yield* a.list, [{ repo: "/repos/a/.git", range: "old1..old2" }]);
          assert.deepStrictEqual(deliveryOf(yield* a.list), {
            pending: 1,
            firstFailureAt: null,
            lastAttemptAt: null,
            lastErrorCode: null,
          });

          yield* TestClock.setTime(Date.parse("2026-10-25T23:23:10Z"));
          yield* a.failed("x1..x2", "CONNECTION_REFUSED");
          yield* TestClock.setTime(Date.parse("2026-10-26T08:00:00Z"));
          yield* a.failed("x1..x2", "BACKEND_FAILED");
          const x = (yield* a.list).find((p) => p.range === "x1..x2");
          assert.deepStrictEqual(x, {
            repo: "/repos/a/.git",
            range: "x1..x2",
            firstFailureAt: "2026-10-25T23:23:10.000Z",
            lastAttemptAt: "2026-10-26T08:00:00.000Z",
            lastErrorCode: "BACKEND_FAILED",
          });
          const delivery = deliveryOf(yield* a.list);
          assert.strictEqual(
            deliveryLine(delivery),
            "Delivery: 2 ranges pending (first failure 2026-10-25T23:23Z, last attempt 2026-10-26T08:00Z, last error BACKEND_FAILED)",
          );
          assert.strictEqual(
            deliveryWarning(delivery),
            "history delivery is failing: 2 ranges pending since 2026-10-25T23:23Z; run `toolreader history status`",
          );
          assert.isNull(deliveryWarning(deliveryOf([])));
        }).pipe(Effect.provide(configAt(home)));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("prints status: the backend, what's pending, and a failed check by its code", () => {
    assert.deepStrictEqual(
      statusLines({
        backend: { url: "http://127.0.0.1:4790", workspace: "acme", hasToken: true },
        delivery: {
          pending: 1,
          firstFailureAt: "2026-10-25T23:23:10.000Z",
          lastAttemptAt: "2026-10-26T08:00:00.000Z",
          lastErrorCode: "CONNECTION_REFUSED",
          ranges: [
            {
              range: `${"a".repeat(40)} --not ${"b".repeat(40)}`,
              firstFailureAt: "2026-10-25T23:23:10.000Z",
              lastAttemptAt: "2026-10-26T08:00:00.000Z",
              lastErrorCode: "CONNECTION_REFUSED",
            },
          ],
        },
        check: { ok: false, errorCode: "CONNECTION_REFUSED" },
      }),
      [
        "Backend: http://127.0.0.1:4790 (workspace acme)",
        "Delivery: 1 range pending (first failure 2026-10-25T23:23Z, last attempt 2026-10-26T08:00Z, last error CONNECTION_REFUSED)",
        "  aaaaaaaa --not bbbbbbbb: first failure 2026-10-25T23:23Z, last attempt 2026-10-26T08:00Z, last error CONNECTION_REFUSED",
        "Check: failed (CONNECTION_REFUSED)",
      ],
    );
    assert.deepStrictEqual(
      statusLines({
        backend: { url: null, workspace: null, hasToken: false },
        delivery: {
          pending: 0,
          firstFailureAt: null,
          lastAttemptAt: null,
          lastErrorCode: null,
          ranges: [],
        },
      }),
      ["Backend: not configured", "Delivery: nothing pending"],
    );
  });

  it.live("checks the backend on request, and names why it failed by code", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "toolreader-status-" });
      // A port nothing listens on any more.
      const port = yield* Effect.promise(
        () =>
          new Promise<number>((resolve) => {
            const server = NodeNet.createServer().listen(0, "127.0.0.1", () => {
              const { port } = server.address() as NodeNet.AddressInfo;
              server.close(() => resolve(port));
            });
          }),
      );
      const config = `${home}/config.json`;
      yield* fs.writeFileString(
        config,
        encodeJson({
          backend: { url: `http://127.0.0.1:${port}`, token: "trk_x", workspace: "acme" },
        }),
      );
      const status = yield* deliveryStatus(home, true).pipe(Effect.provide(configAt(home, config)));
      assert.deepStrictEqual(status.backend, {
        url: `http://127.0.0.1:${port}`,
        workspace: "acme",
        hasToken: true,
      });
      assert.deepStrictEqual(status.check, { ok: false, errorCode: "CONNECTION_REFUSED" });
      assert.strictEqual(status.delivery.pending, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
