// The search benchmark (plan W4): how long `search` takes at a pilot's scale and past it, today's
// scan against one index candidate, so the index engine (decision D8) is chosen on numbers.
// Opt-in, slow and heavy: TOOLREADER_BENCH=1 vp test run src/server/backend/searchBench.test.ts
// Writes a table to TOOLREADER_BENCH_OUT (search-bench.md); docs/benchmark.md keeps the last run's.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import type { Entry } from "../../core/domain.ts";
import { HistoryStore } from "./HistoryStore.ts";
import { PgMigrationsLive } from "./PgMigrations.ts";
import { inWorkspace, PgTestLive } from "./testPostgres.ts";
import { threadRecord } from "./testRecords.ts";

const TestLive = HistoryStore.layer.pipe(
  Layer.provideMerge(PgMigrationsLive),
  Layer.provideMerge(PgTestLive),
  Layer.provideMerge(NodeServices.layer),
);

const WORDS = "retry store client handler upload thread commit branch config schema worker".split(
  " ",
);
/** A session of `n` actions, each with ~400 bytes of output; one in 50 sessions hits the needle. */
const session = (i: number, n: number): Entry[] =>
  Array.from({ length: n }, (_, j) => ({
    type: "action" as const,
    id: `a${j}`,
    at: `2026-01-01T${String(Math.floor((i % 86400) / 3600)).padStart(2, "0")}:${String(Math.floor((i % 3600) / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.${String(j % 1000).padStart(3, "0")}Z`,
    kind: "test" as const,
    status: j % 7 === 0 ? ("failed" as const) : ("ok" as const),
    title: `vitest run src/${WORDS[(i + j) % WORDS.length]}.test.ts`,
    command: `vitest run src/${WORDS[(i + j) % WORDS.length]}.test.ts`,
    output: `${Array.from({ length: 40 }, (_, k) => WORDS[(i * j + k) % WORDS.length]).join(" ")}${
      i % 50 === 0 && j === 3 ? " TypeError: needleCannotRead of undefined" : ""
    }`,
  }));

const time = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const start = performance.now();
    yield* self;
    return Math.round(performance.now() - start);
  });

describe.skipIf(!process.env["TOOLREADER_BENCH"])("search benchmark", () => {
  it.layer(TestLive, { timeout: 3_600_000 })((it) => {
    it.effect(
      "times search at 1k and 10k sessions, plus one huge one: today's scan and a trigram prefilter",
      () =>
        Effect.gen(function* () {
          const sql = yield* PgClient;
          const store = yield* inWorkspace("bench");
          const rows: string[] = [];
          let stored = 0;
          const fill = (upTo: number) =>
            Effect.gen(function* () {
              for (; stored < upTo; stored++)
                yield* store.putThread(threadRecord(`s${stored}`, session(stored, 20)));
            });
          const measure = (label: string) =>
            Effect.gen(function* () {
              const needle = yield* time(store.search({ text: "needleCannotRead", limit: 20 }));
              const common = yield* time(store.search({ text: "retry", limit: 20 }));
              const none = yield* time(store.search({ text: "zzznothing", limit: 20 }));
              // The candidate: a trigram index on the whole payload, as a prefilter per thread.
              const pre = yield* time(sql`
                SELECT t.id FROM threads t, jsonb_array_elements(t.payload->'entries') e
                WHERE t.payload::text ILIKE '%needleCannotRead%'
                  AND (e->>'output' ILIKE '%needleCannotRead%') LIMIT 21`);
              const [size] = yield* sql<{ mb: number }>`
                SELECT round(pg_total_relation_size('threads') / 1048576.0)::int AS mb`;
              rows.push(
                `| ${label} | ${needle} | ${common} | ${none} | ${pre} | ${size?.mb ?? "?"} |`,
              );
            });
          yield* fill(1_000);
          yield* measure("1,000 sessions × 20 actions");
          yield* fill(10_000);
          yield* measure("10,000 sessions × 20 actions");
          yield* store.putThread(threadRecord("huge", session(1, 20_000)));
          yield* measure("+ one session of 20,000 actions");
          yield* sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`;
          yield* sql`CREATE INDEX threads_trgm ON threads USING gin ((payload::text) gin_trgm_ops)`;
          yield* measure("same, with the trigram index");
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(
            process.env["TOOLREADER_BENCH_OUT"] ?? "search-bench.md",
            [
              "| corpus | rare text (ms) | common word (ms) | no match (ms) | trigram prefilter, rare (ms) | threads table (MB) |",
              "|---|---|---|---|---|---|",
              ...rows,
            ].join("\n") + "\n",
          );
        }),
      3_600_000,
    );
  });
});
