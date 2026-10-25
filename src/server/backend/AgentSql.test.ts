// Agents' SQL against a real Postgres (testPostgres.ts): what a workspace's agent login reads, and
// every way out of it we know of, each refused or empty.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { Entry } from "../../core/domain.ts";
import { AGENT_LIMITS, AgentSql } from "./AgentSql.ts";
import { HistoryStore } from "./HistoryStore.ts";
import { PgMigrationsLive } from "./PgMigrations.ts";
import { inWorkspace, PgTestLive } from "./testPostgres.ts";
import { threadRecord } from "./testRecords.ts";

const TestLive = AgentSql.layer({ ...AGENT_LIMITS, timeout: Duration.seconds(1) }).pipe(
  Layer.provideMerge(HistoryStore.layer),
  Layer.provideMerge(PgMigrationsLive),
  Layer.provideMerge(PgTestLive),
  Layer.provide(NodeServices.layer),
);

const at = "2026-01-01T10:00:00.000Z";
const steps: Entry[] = [
  { type: "message", id: "u1", at, role: "user", text: "make retries configurable" },
  {
    type: "action",
    id: "a1",
    at,
    kind: "edit",
    status: "ok",
    title: "edit src/retry.ts",
    files: [
      {
        path: "src/retry.ts",
        added: 1,
        removed: 0,
        isNew: false,
        isDeleted: false,
        truncated: true,
        addedKeys: ["const retries = 3"],
      },
    ],
  },
  {
    type: "action",
    id: "a2",
    at,
    kind: "test",
    status: "failed",
    title: "vp test run",
    command: "vp test run",
    exitCode: 1,
  },
  { type: "message", id: "u2", at, role: "user", text: "now fix the test" },
  { type: "action", id: "a3", at, kind: "test", status: "ok", title: "vp test run" },
];

/** Workspace `slug` holding thread `id`; its id. */
const seeded = (slug: string, id: string) =>
  Effect.gen(function* () {
    yield* Effect.flatMap(inWorkspace(slug), (s) => s.putThread(threadRecord(id, steps)));
    return yield* Effect.flatMap(HistoryStore, (s) => s.workspace(slug));
  });

const query = (ws: string, text: string) => Effect.flatMap(AgentSql, (a) => a.query(ws, text));
const refused = (ws: string, text: string) =>
  Effect.map(Effect.flip(query(ws, text)), (e) => {
    assert.strictEqual(e._tag, "AgentQueryFailed", `${text}: ${e.message}`);
    return e.message;
  });

describe("AgentSql", () => {
  it.layer(TestLive, { timeout: 120_000 })((it) => {
    it.effect("reads a conversation's steps by turn, without addedKeys", () =>
      Effect.gen(function* () {
        const ws = yield* seeded("acme", "codex:ours");
        const { rows: threads } = yield* query(
          ws,
          "SELECT id, title, source, entry_count FROM agent_threads",
        );
        assert.deepStrictEqual(threads, [
          { id: "codex:ours", title: "Add a", source: "codex", entry_count: 5 },
        ]);
        const { rows, truncated } = yield* query(
          ws,
          `SELECT turn, seq, kind, status, title, exit_code, files
           FROM agent_entries WHERE thread_id = 'codex:ours' AND type = 'action' ORDER BY seq`,
        );
        assert.isFalse(truncated);
        assert.deepStrictEqual(
          rows.map((r) => [r.turn, r.seq, r.kind, r.status, r.exit_code]),
          [
            [1, 2, "edit", "ok", null],
            [1, 3, "test", "failed", 1],
            [2, 5, "test", "ok", null],
          ],
        );
        assert.deepStrictEqual(rows[0]?.files, [
          {
            path: "src/retry.ts",
            added: 1,
            removed: 0,
            isNew: false,
            isDeleted: false,
            truncated: true,
          },
        ]);
      }),
    );

    it.effect("sees no other workspace's conversation, even by id", () =>
      Effect.gen(function* () {
        const ws = yield* seeded("acme", "codex:ours");
        const rival = yield* seeded("rival", "codex:theirs");
        // Both have logins: the views tell them apart by who asks, not by which ones exist.
        yield* query(rival, "SELECT 1");
        for (const text of [
          "SELECT id FROM agent_threads WHERE id = 'codex:theirs'",
          "SELECT thread_id FROM agent_entries WHERE thread_id = 'codex:theirs'",
          "SELECT DISTINCT thread_id FROM agent_entries WHERE thread_id <> 'codex:ours'",
        ])
          assert.deepStrictEqual((yield* query(ws, text)).rows, [], text);
      }),
    );

    it.effect("refuses the tables behind the views", () =>
      Effect.gen(function* () {
        const ws = yield* seeded("acme", "codex:ours");
        for (const table of ["threads", "entries", "agent_logins", "api_tokens", "members"])
          assert.include(yield* refused(ws, `SELECT * FROM ${table}`), "permission denied");
        // Planner statistics would show the tables' common values; they're only for readers.
        yield* Effect.flatMap(SqlClient.SqlClient, (sql) => sql`ANALYZE threads`);
        assert.deepStrictEqual(
          (yield* query(ws, "SELECT * FROM pg_stats WHERE tablename = 'threads'")).rows,
          [],
        );
      }),
    );

    it.effect("refuses writes", () =>
      Effect.gen(function* () {
        const ws = yield* seeded("acme", "codex:ours");
        for (const text of [
          "DELETE FROM agent_threads",
          "UPDATE agent_entries SET title = 'x'",
          "WITH gone AS (DELETE FROM threads RETURNING 1) SELECT * FROM gone",
          "CREATE TEMP TABLE scratch (a int)",
          "CREATE TABLE agent_more (a int)",
          "SELECT set_config('transaction_read_only', 'off', true)",
        ])
          yield* refused(ws, text);
      }),
    );

    it.effect("can't switch role or run a second statement", () =>
      Effect.gen(function* () {
        const ws = yield* seeded("acme", "codex:ours");
        yield* refused(ws, "SET ROLE postgres");
        yield* refused(ws, "SELECT set_config('role', 'postgres', true)");
        yield* refused(ws, "SET SESSION AUTHORIZATION postgres");
        assert.include(
          yield* refused(ws, "RESET ROLE; SELECT * FROM threads"),
          "multiple commands",
        );
        // RESET ROLE alone succeeds, back to the login it is: still only the views.
        yield* query(ws, "RESET ROLE");
        assert.strictEqual(
          (yield* query(ws, "SELECT count(*)::int AS n FROM agent_threads")).rows[0]?.n,
          1,
        );
      }),
    );

    it.effect("refuses the server's files", () =>
      Effect.gen(function* () {
        const ws = yield* seeded("acme", "codex:ours");
        yield* refused(ws, "SELECT pg_read_file('/etc/passwd')");
        yield* refused(ws, "SELECT pg_ls_dir('.')");
        yield* refused(ws, "COPY (SELECT 1) TO '/tmp/agent'");
      }),
    );

    it.effect("stops a slow query, even one that turns its timeout off", () =>
      Effect.gen(function* () {
        const ws = yield* seeded("acme", "codex:ours");
        assert.include(
          yield* refused(ws, "SELECT set_config('statement_timeout', '0', true), pg_sleep(30)"),
          "statement timeout",
        );
      }),
    );

    it.effect("caps rows and bytes", () =>
      Effect.gen(function* () {
        const ws = yield* seeded("acme", "codex:ours");
        const many = yield* query(ws, "SELECT generate_series(1, 5000) AS n");
        assert.strictEqual(many.rows.length, AGENT_LIMITS.rows);
        assert.isTrue(many.truncated);
        const big = yield* query(ws, "SELECT repeat('x', 2000000) AS big");
        assert.deepStrictEqual(big, { rows: [], truncated: true });
      }),
    );
  });
});
