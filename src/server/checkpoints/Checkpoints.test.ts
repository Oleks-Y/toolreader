import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";

import { ThreadNotFound } from "../../core/api.ts";
import type { ThreadView } from "../../core/domain.ts";
import { Checkpoints } from "./Checkpoints.ts";
import { DirectSink } from "../directSink.ts";
import { CheckpointStore } from "../backend/CheckpointStore.ts";
import { ClaudeTranscripts } from "../ClaudeTranscripts.ts";
import { CodexRollouts } from "../CodexRollouts.ts";
import { Labeler } from "../Labeler.ts";
import { PgMigrationsLive } from "../backend/PgMigrations.ts";
import { ServerConfig } from "../ServerConfig.ts";
import { PgTestLive } from "../backend/testPostgres.ts";
import { ThreadStore } from "../ThreadStore.ts";

const SECRET = "API_TOKEN=supersecret";

const view: ThreadView = {
  thread: {
    id: "t1",
    source: "t3",
    origin: null,
    title: `Use ${SECRET}`,
    projectId: "p",
    projectTitle: "repo",
    provider: "claudeAgent",
    status: "idle",
    archived: false,
    updatedAt: "2026-01-01T10:05:00Z",
    actionCount: 1,
    worktree: null,
    head: "h",
  },
  entries: [
    { type: "message", id: "u1", at: "2026-01-01T10:00:00Z", role: "user", text: `Use ${SECRET}` },
    {
      type: "action",
      id: "a1",
      at: "2026-01-01T10:00:10Z",
      kind: "test",
      status: "ok",
      title: "vp test",
    },
    { type: "message", id: "u2", at: "2026-01-01T10:01:00Z", role: "user", text: "again" },
  ],
  labels: {},
};

// T3 as ThreadStore shows it: one Claude thread, known by its native session id.
const ThreadStoreFake = Layer.succeed(
  ThreadStore,
  ThreadStore.of({
    list: Effect.succeed([]),
    get: (id) =>
      id === "t1" ? Effect.succeed(view) : Effect.fail(new ThreadNotFound({ threadId: id })),
    head: () => Effect.die("unused"),
    codexThreadIds: Effect.succeed(new Set()),
    lineage: Effect.succeed({
      nativeIds: new Map([["claude-native", "t1"]]),
      parents: new Map(),
    }),
    claudeSessionIds: Effect.succeed(new Set(["claude-native"])),
    projects: Effect.succeed([]),
    turnMeta: () =>
      Effect.succeed([
        {
          promptId: "u1",
          model: "claude-opus-5-5",
          usage: { input: 10, cachedInput: null, output: 2, reasoning: null, total: 12 },
          startedAt: "2026-01-01T10:00:00Z",
          endedAt: "2026-01-01T10:00:30Z",
        },
      ]),
  }),
);

const TestLive = Checkpoints.layer.pipe(
  Layer.provideMerge(DirectSink),
  Layer.provideMerge(CheckpointStore.layer),
  Layer.provide(PgMigrationsLive),
  Layer.provideMerge(PgTestLive),
  Layer.provide([CodexRollouts.layer, ClaudeTranscripts.layer]),
  Layer.provide([
    ThreadStoreFake,
    Layer.succeed(
      Labeler,
      Labeler.of({ forThread: () => Effect.succeed({}), label: () => Effect.die("unused") }),
    ),
    Layer.succeed(
      ServerConfig,
      ServerConfig.of({
        port: 0,
        home: "/home/me",
        dbPath: "",
        codexBin: "codex",
        codexHome: "/nonexistent",
        claudeHome: "/nonexistent",
        labelsPath: "",
        userConfigPath: "",
        distDir: "",
      }),
    ),
  ]),
  Layer.provideMerge(NodeServices.layer),
);

const request = { repo: null, replace: false, outputs: true, maxOutput: 8192 };

describe("Checkpoints", () => {
  it.layer(TestLive, { timeout: 120_000 })((it) => {
    it.effect("stores a session found by what its agent exports, with its turns", () =>
      Effect.gen(function* () {
        const checkpoints = yield* Checkpoints;
        const { checkpoint: cp, result } = yield* checkpoints.take({
          ...request,
          session: "claude-code:claude-native",
          trigger: "manual",
        });
        assert.strictEqual(result, "inserted");
        assert.strictEqual(cp.id, "manual:t1:u2");
        assert.strictEqual(cp.session, "claude-code:claude-native");
        assert.strictEqual(cp.thread.title, "Use API_TOKEN=[redacted]");
        assert.deepStrictEqual(
          cp.turns.map((t) => [t.id, t.model, t.usage?.total ?? null]),
          [
            ["u1", "claude-opus-5-5", 12],
            ["u2", null, null],
          ],
        );
      }),
    );

    it.effect("takes the same checkpoint again under any name of the session", () =>
      Effect.gen(function* () {
        const checkpoints = yield* Checkpoints;
        const again = yield* checkpoints.take({ ...request, session: "t1", trigger: "manual" });
        assert.strictEqual(again.result, "exists");
        assert.strictEqual(again.checkpoint.session, "claude-code:claude-native");
        // toolreader's own name for a Claude session is the trailer's, stored the same way.
        const named = yield* checkpoints.take({
          ...request,
          session: "claude:claude-native",
          trigger: "manual",
        });
        assert.deepStrictEqual(
          [named.result, named.checkpoint.session],
          ["exists", "claude-code:claude-native"],
        );
      }),
    );

    // The pipeline's order is the architecture: read, then redact (build), and only then store.
    it.effect("runs its steps in order: resolve, repo, build, store", () =>
      Effect.gen(function* () {
        const spans: Tracer.NativeSpan[] = [];
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options);
            spans.push(span);
            return span;
          },
        });
        yield* Effect.flatMap(Checkpoints, (c) =>
          c.take({ ...request, session: "t1", trigger: "manual", replace: true }),
        ).pipe(Effect.provideService(Tracer.Tracer, tracer));
        const take = spans.find((s) => s.name === "Checkpoints.take")!;
        const steps = spans
          .filter((s) => Option.getOrNull(s.parent)?.spanId === take.spanId)
          .map((s) => s.name);
        assert.deepStrictEqual(steps, [
          "Checkpoints.resolve",
          "Checkpoints.repoInfo",
          "Checkpoints.build",
          "CheckpointStore.put",
        ]);
        const build = spans.find((s) => s.name === "Checkpoints.build")!;
        assert.isAbove(Number(build.attributes.get("redactions")), 0);
        assert.strictEqual(take.attributes.get("result"), "exists");
        // Spans go to trace files and collectors: ids, counts, parameterized SQL and the database's
        // host and port (OpenTelemetry's `server.address`), never session text, the home directory
        // or the database URL and its credentials.
        const values = spans.flatMap((s) => [...s.attributes.values()].map(String));
        assert.isTrue(values.some((v) => v.includes("INSERT INTO checkpoints")));
        for (const leak of [
          "supersecret",
          "Use API_TOKEN",
          "/home/me",
          "postgres://",
          ":toolreader@",
        ])
          assert.isFalse(
            values.some((v) => v.includes(leak)),
            `a span attribute holds ${leak}`,
          );
      }),
    );

    it.effect("takes a commit link's own window, through the same steps", () =>
      Effect.gen(function* () {
        const spans: Tracer.NativeSpan[] = [];
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options);
            spans.push(span);
            return span;
          },
        });
        const commit = {
          sha: "abc123",
          subject: "feat: a",
          committedAt: "2026-01-01T10:00:20Z",
          patchId: null,
        };
        const { checkpoint: cp, result } = yield* Effect.flatMap(Checkpoints, (c) =>
          c.take({
            ...request,
            trigger: "commit",
            link: {
              commit: { commit, previousAt: null, trailers: [], paths: ["a.ts"] },
              found: {
                thread: { ...view.thread, parent: null },
                role: "coder",
                via: "trailer",
                reviewedSha: null,
                segment: view.entries.slice(0, 2),
                labels: {},
              },
            },
          }),
        ).pipe(Effect.provideService(Tracer.Tracer, tracer));
        assert.deepStrictEqual(
          [cp.id, result, cp.entries.map((e) => e.id)],
          ["commit:unknown:abc123:t1:coder", "inserted", ["u1", "a1"]],
        );
        assert.deepStrictEqual(
          [cp.trigger, cp.commit?.via, cp.commit?.paths],
          ["commit", "trailer", ["a.ts"]],
        );
        const take = spans.find((s) => s.name === "Checkpoints.take")!;
        assert.deepStrictEqual(
          spans
            .filter((s) => Option.getOrNull(s.parent)?.spanId === take.spanId)
            .map((s) => s.name),
          [
            "Checkpoints.resolve",
            "Checkpoints.repoInfo",
            "Checkpoints.build",
            "CheckpointStore.put",
          ],
        );
      }),
    );

    it.effect("fails on a session no source knows", () =>
      Effect.gen(function* () {
        const checkpoints = yield* Checkpoints;
        const error = yield* Effect.flip(
          checkpoints.take({ ...request, session: "codex:nope", trigger: "manual" }),
        );
        assert.strictEqual(error._tag, "CheckpointFailed");
      }),
    );
  });
});
