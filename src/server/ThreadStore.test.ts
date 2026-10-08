import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "./NodeSqliteClient.ts";
import { ServerConfig } from "./ServerConfig.ts";
import { ThreadStore } from "./ThreadStore.ts";

const payload = (command: string, exitCode: number) =>
  JSON.stringify({
    itemType: "command_execution",
    toolCallId: `call-${command}`,
    status: "completed",
    data: { item: { command, exitCode } },
  });

// Just the T3 columns ThreadStore reads.
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table projection_projects (project_id text primary key, title text not null, workspace_root text not null)`;
  yield* sql`create table projection_threads (thread_id text primary key, project_id text not null, title text not null, worktree_path text, updated_at text not null, deleted_at text, archived_at text)`;
  yield* sql`create table projection_thread_sessions (thread_id text primary key, provider_name text, status text not null)`;
  yield* sql`create table projection_thread_activities (activity_id text primary key, thread_id text not null, kind text not null, tone text not null, summary text not null, payload_json text not null, created_at text not null)`;
  yield* sql`create table projection_thread_messages (message_id text primary key, thread_id text not null, role text not null, text text not null, created_at text not null, updated_at text not null)`;
  yield* sql`insert into projection_projects values ('p1', 'toolreader', '/repo')`;
  yield* sql`insert into projection_threads values ('t1', 'p1', 'Fix it', null, '2026-01-01T00:00:00Z', null, null), ('gone', 'p1', 'Deleted', null, '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z', null)`;
  yield* sql`insert into projection_thread_sessions values ('t1', 'codex', 'running')`;
  yield* sql`insert into projection_thread_messages values ('m1', 't1', 'user', 'fix the build', '2026-01-01T00:00:01Z', '2026-01-01T00:00:01Z')`;
  yield* sql`insert into projection_thread_activities values
    ('a1', 't1', 'tool.completed', 'tool', 'Ran command', ${payload("sed -n '1,20p' /repo/src/a.ts", 0)}, '2026-01-01T00:00:02Z'),
    ('a2', 't1', 'context-window.updated', 'info', 'ignored', '{}', '2026-01-01T00:00:03Z'),
    ('a3', 't1', 'tool.completed', 'tool', 'Ran command', 'not json', '2026-01-01T00:00:04Z')`;
});

const SqlLive = Layer.effectDiscard(seed).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));
const ConfigLive = Layer.succeed(
  ServerConfig,
  ServerConfig.of({
    port: 0,
    home: "/home/me",
    dbPath: ":memory:",
    codexBin: "codex",
    codexHome: "/home/me/.codex",
    labelsPath: "/dev/null",
    userConfigPath: "",
    distDir: "dist",
  }),
);
const TestLive = ThreadStore.layer.pipe(
  Layer.provideMerge(SqlLive),
  Layer.provide(ConfigLive),
  Layer.provide(NodeServices.layer),
);

describe("ThreadStore", () => {
  it.layer(TestLive)((it) => {
    it.effect("lists non-deleted threads with cached action counts", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const [thread, ...rest] = yield* store.list;
        assert.strictEqual(rest.length, 0);
        assert.deepStrictEqual(
          [thread?.id, thread?.status, thread?.provider, thread?.actionCount],
          ["t1", "running", "codex", 2],
        );

        const sql = yield* SqlClient.SqlClient;
        yield* sql`insert into projection_thread_activities values ('a4', 't1', 'tool.completed', 'tool', 'x', ${payload("ls", 0)}, '2026-01-01T00:00:05Z')`;
        const [after] = yield* store.list;
        assert.strictEqual(
          after?.actionCount,
          3,
          "count cache refreshes when the thread's newest row changes",
        );
      }),
    );

    it.effect("normalizes a thread, tidying worktree paths and tolerating bad payloads", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const view = yield* store.get("t1", { a1: "Read a.ts" });
        const titles = view.entries.map((e) =>
          e.type === "action" ? e.title : `${e.type}:${e.type === "message" ? e.text : ""}`,
        );
        assert.deepStrictEqual(titles.slice(0, 2), ["message:fix the build", "read src/a.ts:1-20"]);
        assert.strictEqual(view.labels["a1"], "Read a.ts");
        assert.isTrue(
          view.entries.some((e) => e.id === "a3"),
          "unparseable payload still yields a row",
        );
      }),
    );

    it.effect("fails with ThreadNotFound for deleted or unknown threads", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const error = yield* Effect.flip(store.get("gone", {}));
        assert.strictEqual(error._tag, "ThreadNotFound");
        const headError = yield* Effect.flip(store.head("nope"));
        assert.strictEqual(headError._tag, "ThreadNotFound");
      }),
    );

    it.effect("head changes when new activity lands", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const before = yield* store.head("t1");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`insert into projection_thread_activities values ('a5', 't1', 'tool.started', 'tool', 'x', '{}', '2026-01-01T00:00:06Z')`;
        const after = yield* store.head("t1");
        assert.notStrictEqual(before.head, after.head);
        assert.strictEqual(after.status, "running");
      }),
    );
  });
});

// T3 0.0.46 nightlies: the V1 tables above, frozen, plus V2's. Just the V2 columns ThreadStore reads.
const seedV2 = Effect.gen(function* () {
  yield* seed;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table orchestration_v2_projection_threads (thread_id text primary key, project_id text not null, title text not null, default_provider text not null, updated_at text not null, archived_at text, deleted_at text, payload_json text not null)`;
  yield* sql`create table orchestration_v2_projection_runs (run_id text primary key, thread_id text not null, ordinal integer not null, status text not null)`;
  yield* sql`create table orchestration_v2_projection_turn_items (turn_item_id text primary key, thread_id text not null, ordinal integer not null, type text not null, status text not null, updated_at text not null, payload_json text not null)`;
  yield* sql`create table orchestration_v2_projection_provider_threads (provider_thread_id text primary key, provider text not null, payload_json text not null)`;
  yield* sql`create table provider_session_runtime (thread_id text primary key, provider_name text not null, resume_cursor_json text)`;
  yield* sql`insert into orchestration_v2_projection_threads values
    ('t1', 'p1', 'Fix it', 'codex', '2026-01-01T00:00:00Z', null, null, '{}'),
    ('n1', 'p1', 'New work', 'claudeAgent', '2026-02-01T00:00:00Z', null, null, '{"worktreePath":"/wt"}'),
    ('gone', 'p1', 'Deleted', 'codex', '2026-01-02T00:00:00Z', null, '2026-01-03T00:00:00Z', '{}')`;
  yield* sql`insert into orchestration_v2_projection_runs values ('r1', 'n1', 1, 'completed'), ('r2', 'n1', 2, 'running')`;
  const turnItem = (
    id: string,
    thread: string,
    ordinal: number,
    type: string,
    at: string,
    fields: object,
  ) =>
    sql`insert into orchestration_v2_projection_turn_items values (${id}, ${thread}, ${ordinal}, ${type}, 'completed', ${at}, ${JSON.stringify({ startedAt: at, ...fields })})`;
  // T3 copies V1 messages into V2; the V1 rows stay the source for those.
  yield* turnItem("migration:v1:turn-item:m1", "t1", 1, "user_message", "2026-01-01T00:00:01Z", {
    text: "fix the build",
  });
  yield* turnItem("i1", "t1", 1000001, "command_execution", "2026-01-05T00:00:00Z", {
    input: "pnpm test",
    exitCode: 0,
  });
  yield* turnItem("i2", "n1", 1000001, "user_message", "2026-02-01T00:00:01Z", { text: "start" });
  yield* turnItem("i3", "n1", 1000002, "dynamic_tool", "2026-02-01T00:00:02Z", {
    toolName: "Read",
    input: { file_path: "/wt/src/b.ts" },
  });
  yield* sql`insert into provider_session_runtime values ('t1', 'codex', '{"threadId":"codex-v1"}')`;
  yield* sql`insert into orchestration_v2_projection_provider_threads values ('pt1', 'codex', '{"nativeThreadRef":{"nativeId":"codex-v2"}}')`;
});

const TestV2Live = ThreadStore.layer.pipe(
  Layer.provideMerge(
    Layer.effectDiscard(seedV2).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
  ),
  Layer.provide(ConfigLive),
  Layer.provide(NodeServices.layer),
);

describe("ThreadStore on orchestration V2", () => {
  it.layer(TestV2Live)((it) => {
    it.effect("lists V2 threads, counting V1 and V2 actions", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const threads = yield* store.list;
        assert.deepStrictEqual(
          threads.map((t) => [t.id, t.provider, t.status, t.actionCount, t.worktree]),
          [
            ["n1", "claudeAgent", "running", 1, "/wt"],
            ["t1", "codex", "idle", 3, "/repo"],
          ],
        );
      }),
    );

    it.effect("merges a V1 thread's history with what ran since, without imported copies", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const view = yield* store.get("t1", {});
        const ids = view.entries.map((e) => e.id);
        assert.deepStrictEqual([ids[0], ids.at(-1)], ["m1", "i1"]);
        assert.isFalse(ids.some((id) => id.startsWith("migration:")));
        const n1 = yield* store.get("n1", {});
        assert.deepStrictEqual(
          n1.entries.map((e) => (e.type === "action" ? e.title : e.type)),
          ["message", "read src/b.ts"],
        );
      }),
    );

    it.effect("head changes when a turn item lands, and knows T3's Codex threads", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const before = yield* store.head("n1");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`insert into orchestration_v2_projection_turn_items values ('i4', 'n1', 1000003, 'reasoning', 'running', '2026-02-01T00:00:03Z', '{}')`;
        const after = yield* store.head("n1");
        assert.notStrictEqual(before.head, after.head);
        assert.strictEqual(after.status, "running");
        // Streamed text rewrites an item in place, keeping its timestamp.
        yield* sql`update orchestration_v2_projection_turn_items set payload_json = '{"text":"more"}' where turn_item_id = 'i4'`;
        assert.notStrictEqual((yield* store.head("n1")).head, after.head);
        const gone = yield* Effect.flip(store.head("gone"));
        assert.strictEqual(gone._tag, "ThreadNotFound");
        assert.deepStrictEqual([...(yield* store.codexThreadIds)].sort(), ["codex-v1", "codex-v2"]);
      }),
    );
  });
});
