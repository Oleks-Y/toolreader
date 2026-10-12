// The backend client against the real backend (a test server on 127.0.0.1, Docker Postgres), and
// against a port nothing listens on.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";

import { checkpointKey, type Checkpoint } from "../../core/checkpoint.ts";
import v1Json from "../../core/fixtures/checkpoint-v1.json" with { type: "json" };
import { BackendRoutes } from "../backend/Backend.ts";
import { BackendSink, backendSettings, classify, type BackendSettings } from "./BackendClient.ts";
import { CheckpointSink } from "./Checkpoints.ts";
import { CheckpointStore } from "../backend/CheckpointStore.ts";
import { PgMigrationsLive } from "../backend/PgMigrations.ts";
import { ServerConfig } from "../ServerConfig.ts";
import { PgTestLive } from "../backend/testPostgres.ts";

const v1 = v1Json as unknown as Checkpoint;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** The fixture as `threadId`'s checkpoint in `repo`, keyed as the backend recomputes it. */
const record = (threadId: string, repo = v1.repo.name, title = v1.thread.title): Checkpoint => ({
  ...v1,
  thread: { ...v1.thread, id: threadId, title },
  repo: { ...v1.repo, name: repo },
  id: checkpointKey({
    trigger: v1.trigger,
    threadId,
    repo,
    commit: v1.commit && { sha: v1.commit.sha, role: v1.commit.role },
    entries: v1.entries,
  }),
});

const ServerLive = HttpRouter.serve(BackendRoutes, {
  disableListenLog: true,
  disableLogger: true,
}).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(CheckpointStore.layer),
  Layer.provideMerge(PgMigrationsLive),
  Layer.provideMerge(PgTestLive),
  Layer.provide(NodeServices.layer),
);

/** A fresh home (outbox, meta cache, config.json) for one test. */
const home = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "toolreader-client-" }));
});
const configAt = (dir: string) =>
  Layer.succeed(
    ServerConfig,
    ServerConfig.of({
      port: 0,
      home: dir,
      dbPath: "",
      codexBin: "codex",
      codexHome: "",
      claudeHome: "",
      labelsPath: "",
      userConfigPath: `${dir}/.toolreader/config.json`,
      distDir: "",
    }),
  );

/** Settings for the test server, with a fresh token for `workspace`. */
const live = (workspace: string) =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const port = server.address._tag === "TcpAddress" ? server.address.port : 0;
    const token = yield* Effect.flatMap(CheckpointStore, (s) => s.createToken(workspace, "test"));
    return { url: `http://127.0.0.1:${port}`, token: Redacted.make(token), workspace };
  });
const DOWN: BackendSettings = {
  url: "http://127.0.0.1:1",
  token: Redacted.make("trk_x"),
  workspace: "down",
};

/** Runs `f` with a sink for `settings` and `dir` as home. */
const withSink = <A, E>(
  settings: BackendSettings,
  dir: string,
  f: (sink: CheckpointSink["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.flatMap(CheckpointSink, f).pipe(
    Effect.provide(BackendSink(settings).pipe(Layer.provide(configAt(dir)))),
  );

const outboxFiles = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const outbox = path.join(dir, ".toolreader", "outbox");
    const names = yield* fs.readDirectory(outbox).pipe(Effect.orElseSucceed(() => []));
    return yield* Effect.forEach(names, (n) =>
      Effect.map(fs.stat(path.join(outbox, n)), (s) => ({ name: n, mode: s.mode & 0o777 })),
    );
  });

describe("BackendClient", () => {
  it.layer(ServerLive, { timeout: 120_000 })((it) => {
    it.effect("uploads through /v1, idempotently, and caches the version check", () =>
      Effect.gen(function* () {
        const dir = yield* home;
        const settings = yield* live("client-put");
        const cp = record("client-put");
        const [first, again] = yield* withSink(settings, dir, (sink) =>
          Effect.all([sink.put(cp, { replace: false }), sink.put(cp, { replace: false })]),
        );
        assert.deepStrictEqual([first.result, again.result], ["inserted", "exists"]);
        // Built records have optional fields left undefined; JSON has no such value.
        const built = record("client-built");
        const withUndefined = {
          ...built,
          entries: built.entries.map((e) => ({ ...e, command: undefined })),
        } as unknown as Checkpoint;
        const sent = yield* withSink(settings, dir, (sink) =>
          sink.put(withUndefined, { replace: false }),
        );
        assert.deepStrictEqual([sent.result, sent.detail], ["inserted", null]);
        const fs = yield* FileSystem.FileSystem;
        assert.include(
          yield* fs.readFileString(`${dir}/.toolreader/cache/meta.json`),
          settings.url,
        );
        assert.deepStrictEqual(yield* outboxFiles(dir), []);
      }),
    );

    it.effect("queues what it can't send, readable by you only, and sends it on the next run", () =>
      Effect.gen(function* () {
        const dir = yield* home;
        const settings = yield* live("client-queued");
        // The same backend and workspace, refusing the token: queued for them.
        const refused = { ...settings, token: Redacted.make("trk_wrong") };
        const cp = record("client-queued");
        const pairs = [{ oldSha: "a".repeat(40), newSha: "b".repeat(40) }];
        const [put, rewrite, fork] = yield* withSink(refused, dir, (sink) =>
          Effect.all([
            sink.put(cp, { replace: false }),
            sink.rewrite("acme/widgets", pairs),
            // The same pairs in another repo are another entry.
            sink.rewrite("acme/fork", pairs),
          ]),
        );
        assert.deepStrictEqual(
          [put.result, rewrite.result, fork.result],
          ["queued", "queued", "queued"],
        );
        assert.include(put.detail, "refused the token");
        const queued = yield* outboxFiles(dir);
        assert.strictEqual(queued.length, 3);
        for (const f of queued) assert.strictEqual(f.mode, 0o600);

        // Still refused: nothing leaves the outbox, and the run says why.
        const stuck = yield* withSink(refused, dir, (sink) => sink.flush());
        assert.deepStrictEqual(stuck.sent, []);
        assert.include(stuck.blocked, "refused the token");
        assert.strictEqual((yield* outboxFiles(dir)).length, 3);

        // Another backend leaves them alone.
        const other = yield* withSink(DOWN, dir, (sink) => sink.flush());
        assert.deepStrictEqual([other.sent, other.elsewhere], [[], 3]);

        const sent = yield* withSink(settings, dir, (sink) => sink.flush());
        assert.deepStrictEqual(
          sent.sent.map((s) => [s.id, s.result]).sort(),
          [
            [cp.id, "inserted"],
            ["rewrites of acme/widgets", "inserted"],
            ["rewrites of acme/fork", "inserted"],
          ].sort(),
        );
        assert.isNull(sent.blocked);
        assert.deepStrictEqual(yield* outboxFiles(dir), []);
      }),
    );

    it.effect(
      "checks a queued record again before it leaves, and drops one that isn't redacted",
      () =>
        Effect.gen(function* () {
          const dir = yield* home;
          const settings = yield* live("client-requeue");
          const fs = yield* FileSystem.FileSystem;
          // Queued by an older client whose redactor missed this token.
          const leaked = record(
            "client-requeue",
            v1.repo.name,
            "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
          );
          yield* fs.makeDirectory(`${dir}/.toolreader/outbox`, { recursive: true });
          yield* fs.writeFileString(
            `${dir}/.toolreader/outbox/old.json`,
            encodeJson({
              kind: "checkpoint",
              backend: settings.url,
              workspace: settings.workspace,
              id: leaked.id,
              replace: false,
              record: leaked,
            }),
          );
          const flushed = yield* withSink(settings, dir, (sink) => sink.flush());
          assert.deepStrictEqual(
            flushed.sent.map((s) => [s.result, s.detail?.split(":")[0]]),
            [["rejected", "not-redacted"]],
          );
          assert.deepStrictEqual(yield* outboxFiles(dir), []);
          // And it never reached the backend.
          const stored = yield* Effect.flatMap(CheckpointStore, (s) =>
            Effect.flatMap(s.workspace("client-requeue"), (workspaceId) =>
              s.at({ workspaceId, tokenId: null, client: "test" }).get(leaked.id),
            ),
          );
          assert.isTrue(Option.isNone(stored));
        }),
    );

    it.effect("reports a queued entry that isn't a checkpoint, and goes on", () =>
      Effect.gen(function* () {
        const dir = yield* home;
        const settings = yield* live("client-null");
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${dir}/.toolreader/outbox`, { recursive: true });
        yield* fs.writeFileString(
          `${dir}/.toolreader/outbox/null.json`,
          encodeJson({
            kind: "checkpoint",
            backend: settings.url,
            workspace: settings.workspace,
            id: "x",
            replace: false,
            record: null,
          }),
        );
        const flushed = yield* withSink(settings, dir, (sink) => sink.flush());
        assert.deepStrictEqual(
          flushed.sent.map((s) => [s.id, s.result]),
          [["x", "rejected"]],
        );
        assert.deepStrictEqual(yield* outboxFiles(dir), []);
      }),
    );

    it.effect("moves an unreadable outbox file aside and goes on", () =>
      Effect.gen(function* () {
        const dir = yield* home;
        const settings = yield* live("client-unreadable");
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${dir}/.toolreader/outbox`, { recursive: true });
        yield* fs.writeFileString(`${dir}/.toolreader/outbox/broken.json`, "{not json");
        const flushed = yield* withSink(settings, dir, (sink) => sink.flush());
        assert.deepStrictEqual(
          flushed.sent.map((s) => [s.id, s.result]),
          [["broken.json", "rejected"]],
        );
        assert.isTrue(yield* fs.exists(`${dir}/.toolreader/outbox/unreadable/broken.json`));
        const put = yield* withSink(settings, dir, (sink) =>
          sink.put(record("client-unreadable"), { replace: false }),
        );
        assert.strictEqual(put.result, "inserted");
      }),
    );

    it.effect("stops below the backend's minClient, and keeps the record", () =>
      Effect.gen(function* () {
        const dir = yield* home;
        const settings = yield* live("client-old");
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${dir}/.toolreader/cache`, { recursive: true });
        // A fresh cache (the test clock is at 0) from a backend that wants a newer client.
        yield* fs.writeFileString(
          `${dir}/.toolreader/cache/meta.json`,
          `{"url":"${settings.url}","checkedAt":0,"minClient":"99.0.0"}`,
        );
        const sent = yield* withSink(settings, dir, (sink) =>
          sink.put(record("client-old"), { replace: false }),
        );
        assert.deepStrictEqual(
          [sent.result, sent.detail],
          ["queued", "upgrade toolreader to ≥ 99.0.0"],
        );
        assert.strictEqual((yield* outboxFiles(dir)).length, 1);

        // An hour later the cache is stale: the backend is asked again, and it takes this client.
        yield* TestClock.adjust("61 minutes");
        const later = yield* withSink(settings, dir, (sink) => sink.flush());
        assert.deepStrictEqual(
          [later.sent.map((s) => s.result), later.blocked],
          [["inserted"], null],
        );
      }),
    );

    it.effect("reports, and never queues, what the backend will never take", () =>
      Effect.gen(function* () {
        const dir = yield* home;
        const settings = yield* live("client-rejected");
        const [noOrigin, leaked] = yield* withSink(settings, dir, (sink) =>
          Effect.all([
            sink.put(record("client-dir", "widgets"), { replace: false }),
            sink.put(
              record("client-leak", v1.repo.name, "token ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
              {
                replace: false,
              },
            ),
          ]),
        );
        assert.strictEqual(noOrigin.result, "rejected");
        assert.include(noOrigin.detail, "no origin remote");
        assert.strictEqual(leaked.result, "rejected");
        assert.include(leaked.detail, "not-redacted");
        assert.deepStrictEqual(yield* outboxFiles(dir), []);
      }),
    );
  });

  it("retries what a later run may fix, and only that", () => {
    const status = (n: number) =>
      classify({ _tag: "HttpClientError", message: "x", response: { status: n } }).retry;
    // A proxy's 404 or 401 says nothing about the record: only 413 is final.
    assert.deepStrictEqual([502, 503, 429, 408, 400, 401, 404, 413].map(status), [
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
    assert.isTrue(classify({ _tag: "HttpClientError", message: "connection refused" }).retry);
    for (const tag of [
      "UpgradeRequired",
      "Unauthorized",
      "Forbidden",
      "TimeoutError",
      "BackendFailed",
    ])
      assert.isTrue(classify({ _tag: tag, message: "x" }).retry, tag);
    assert.isTrue(classify({ _tag: "SchemaError", message: "x" }).retry);
    // What stops the whole outbox (the backend itself) and what holds back only one entry.
    const wide = (e: object) => classify(e).wide;
    assert.isTrue(wide({ _tag: "HttpClientError", message: "connection refused" }));
    assert.isTrue(wide({ _tag: "Unauthorized", message: "x" }));
    assert.isTrue(wide({ _tag: "HttpClientError", message: "x", response: { status: 503 } }));
    assert.isFalse(wide({ _tag: "HttpClientError", message: "x", response: { status: 403 } }));
    assert.isFalse(wide({ _tag: "SchemaError", message: "x" }));
    for (const tag of ["TooLarge", "LengthRequired"])
      assert.isFalse(classify({ _tag: tag, message: "x" }).retry, tag);
  });

  it.effect("reads settings from config.json, under the environment", () =>
    Effect.gen(function* () {
      const dir = yield* home;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${dir}/.toolreader`, { recursive: true });
      yield* fs.writeFileString(
        `${dir}/.toolreader/config.json`,
        '{"sanitize":{},"backend":{"url":"https://cp.example/","token":"trk_file","workspace":"team"}}',
      );
      const read = (env: Record<string, string>) =>
        backendSettings().pipe(
          Effect.provide(
            Layer.merge(configAt(dir), ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
          ),
        );
      const file = yield* read({});
      assert.deepStrictEqual(
        [file?.url, file && Redacted.value(file.token), file?.workspace],
        ["https://cp.example", "trk_file", "team"],
      );
      const env = yield* read({ TOOLREADER_BACKEND_WORKSPACE: "other" });
      assert.strictEqual(env?.workspace, "other");

      yield* fs.writeFileString(
        `${dir}/.toolreader/config.json`,
        '{"backend":{"url":"https://x"}}',
      );
      assert.include((yield* Effect.flip(read({}))).message, "backend.token");
      yield* fs.writeFileString(`${dir}/.toolreader/config.json`, "{}");
      assert.isNull(yield* read({}));

      // Plain HTTP carries the token and the records in clear: only to this machine.
      const url = (u: string) =>
        read({
          TOOLREADER_BACKEND_URL: u,
          TOOLREADER_BACKEND_TOKEN: "trk_x",
          TOOLREADER_BACKEND_WORKSPACE: "w",
        }).pipe(Effect.map((s) => s?.url));
      assert.strictEqual(yield* url("http://127.0.0.1:4780"), "http://127.0.0.1:4780");
      assert.strictEqual(yield* url("https://cp.example"), "https://cp.example");
      assert.include((yield* Effect.flip(url("http://cp.example"))).message, "https://");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
