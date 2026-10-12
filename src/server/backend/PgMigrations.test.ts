// The history database's migrations. Each test runs in a schema of its own, so it starts from an
// empty database whatever ran before it.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { HistoryStore } from "./HistoryStore.ts";
import { migrate, migrationEntries } from "./PgMigrations.ts";
import { inWorkspace, PgTestLive } from "./testPostgres.ts";

const TestLive = HistoryStore.layer.pipe(
  Layer.provideMerge(PgTestLive),
  Layer.provide(NodeServices.layer),
);

const inFreshSchema = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const schema = `migrate_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
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

    it.effect("refuses a database a newer or another toolreader migrated", () =>
      inFreshSchema(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* migrate();
          yield* sql`INSERT INTO toolreader_migrations (migration_id, name) VALUES (999, 'FromTheFuture')`;
          const newer = yield* Effect.flip(migrate());
          assert.strictEqual(newer._tag, "HistoryStoreFailed");
          assert.include(newer.message, "schema 999, newer than this toolreader knows");
          assert.include(newer.message, "upgrade toolreader");
          yield* sql`DELETE FROM toolreader_migrations WHERE migration_id = 999`;
          yield* sql`UPDATE toolreader_migrations SET name = 'Edited' WHERE migration_id = 1`;
          const edited = yield* Effect.flip(migrate());
          assert.include(edited.message, "another build of toolreader");
        }),
      ),
    );

    it.effect("refuses a record a newer toolreader wrote, by name", () =>
      inFreshSchema(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* migrate();
          const store = yield* inWorkspace("seeded");
          yield* sql`
            INSERT INTO threads (workspace_id, id, payload, content_sha, client)
            SELECT id, 'future', '{"formatVersion": 2}'::jsonb, 'x', '9.9.9'
            FROM workspaces WHERE slug = 'seeded'`;
          const error = yield* Effect.flip(store.threads(["future"]));
          assert.strictEqual(
            error.message,
            "thread format v2 is newer than this toolreader reads (v1): upgrade toolreader",
          );
        }),
      ),
    );
  });
});
