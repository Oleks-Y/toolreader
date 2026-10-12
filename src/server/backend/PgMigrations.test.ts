// Upgrade paths of the checkpoint database. Each test runs in a schema of its
// own, so it starts from an empty database whatever ran before it.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as SqlError from "effect/unstable/sql/SqlError";

import v1 from "../../core/fixtures/checkpoint-v1.json" with { type: "json" };
import { CheckpointStore } from "./CheckpointStore.ts";
import { migrate, migrationEntries } from "./PgMigrations.ts";
import { inWorkspace, PgTestLive } from "./testPostgres.ts";

const TestLive = CheckpointStore.layer.pipe(
  Layer.provideMerge(PgTestLive),
  Layer.provide(NodeServices.layer),
);

const inFreshSchema = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const schema = `upgrade_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`CREATE SCHEMA ${sql(schema)}`;
          yield* sql`SET LOCAL search_path TO ${sql(schema)}`;
          return yield* self;
        }),
      )
      .pipe(Effect.ensuring(Effect.ignore(sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`)));
  });

/**
 * A row as the toolreader of that schema wrote it, in workspace `seeded`: plain SQL, since the
 * store writes the newest.
 */
const insertRaw = (
  payload: { readonly id: string; readonly takenAt: string } & Record<string, unknown>,
) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      WITH ws AS (
        INSERT INTO workspaces (slug) VALUES ('seeded')
        ON CONFLICT (slug) DO UPDATE SET slug = excluded.slug RETURNING id
      )
      INSERT INTO checkpoints (workspace_id, id, payload, taken_at, content_sha, client)
      SELECT ws.id, ${payload.id}, ${JSON.stringify(payload)}::jsonb, ${payload.takenAt},
        'seeded', '0.1.0'
      FROM ws`,
  );

/**
 * One case per released migration: the database as that toolreader left it, with the rows it
 * wrote. Each must migrate to the newest schema and still read. Add a case with each migration;
 * never edit an old one.
 */
const upgrades: ReadonlyArray<{
  readonly from: number;
  readonly seed: Effect.Effect<unknown, SqlError.SqlError, SqlClient.SqlClient>;
}> = [{ from: 1, seed: insertRaw(v1) }];

describe("PgMigrations", () => {
  it.layer(TestLive, { timeout: 120_000 })((it) => {
    it.effect("migrates an empty database, once", () =>
      inFreshSchema(
        Effect.gen(function* () {
          assert.deepStrictEqual(
            yield* migrate(),
            migrationEntries.map(([id, name]) => [id, name] as const),
          );
          assert.deepStrictEqual(yield* migrate(), []);
        }),
      ),
    );

    for (const { from, seed } of upgrades)
      it.effect(`upgrades a database at schema ${from}, keeping its rows`, () =>
        inFreshSchema(
          Effect.gen(function* () {
            yield* migrate({ through: from });
            yield* seed;
            yield* migrate();
            const store = yield* inWorkspace("seeded");
            const stored = Option.getOrThrow(yield* store.get(v1.id));
            assert.strictEqual(stored.thread.id, v1.thread.id);
            // Generated columns still read the payload.
            const found = yield* store.forCommit(v1.repo.name, v1.commit.sha, null);
            assert.deepStrictEqual(
              found.map((f) => [f.checkpoint.id, f.matched]),
              [[v1.id, "sha"]],
            );
          }),
        ),
      );

    it.effect("refuses a database a newer or another toolreader migrated", () =>
      inFreshSchema(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* migrate();
          yield* sql`INSERT INTO toolreader_migrations (migration_id, name) VALUES (999, 'FromTheFuture')`;
          const newer = yield* Effect.flip(migrate());
          assert.strictEqual(newer._tag, "CheckpointStoreFailed");
          assert.include(newer.message, "schema 999, newer than this toolreader knows");
          assert.include(newer.message, "upgrade toolreader");
          yield* sql`DELETE FROM toolreader_migrations WHERE migration_id = 999`;
          yield* sql`UPDATE toolreader_migrations SET name = 'Edited' WHERE migration_id = 1`;
          const edited = yield* Effect.flip(migrate());
          assert.include(edited.message, "another build of toolreader");
        }),
      ),
    );

    it.effect("refuses a checkpoint a newer toolreader wrote, by name", () =>
      inFreshSchema(
        Effect.gen(function* () {
          yield* migrate();
          yield* insertRaw({ ...v1, id: "future", formatVersion: 2, entries: "v2 shape" });
          const store = yield* inWorkspace("seeded");
          const error = yield* Effect.flip(store.get("future"));
          assert.strictEqual(
            error.message,
            "checkpoint format v2 is newer than this toolreader reads (v1): upgrade toolreader",
          );
        }),
      ),
    );
  });
});
