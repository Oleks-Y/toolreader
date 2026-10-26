// The history database's schema, migrated on start the way t3code migrates its SQLite
// (apps/server/src/persistence/Migrations.ts): migrations imported statically, so the bundle
// carries them. Not PgMigrator: its schema dumps need pg_dump and a child process.
// Released migrations are never edited, only appended.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { HistoryStoreFailed } from "./HistoryStore.ts";
import Migration0001 from "./Migrations/001_History.ts";
import Migration0002 from "./Migrations/002_Members.ts";
import Migration0003 from "./Migrations/003_Removed.ts";
import Migration0004 from "./Migrations/004_Blames.ts";
import Migration0005 from "./Migrations/005_Entries.ts";
import Migration0006 from "./Migrations/006_Findings.ts";
import Migration0007 from "./Migrations/007_Corrections.ts";
import Migration0008 from "./Migrations/008_Reviews.ts";
import Migration0009 from "./Migrations/009_AgentSchema.ts";
import Migration0010 from "./Migrations/010_Media.ts";

/** Every migration, in order. Append a new one here and add its case to the upgrade tests. */
export const migrationEntries = [
  [1, "History", Migration0001],
  [2, "Members", Migration0002],
  [3, "Removed", Migration0003],
  [4, "Blames", Migration0004],
  [5, "Entries", Migration0005],
  [6, "Findings", Migration0006],
  [7, "Corrections", Migration0007],
  [8, "Reviews", Migration0008],
  [9, "AgentSchema", Migration0009],
  [10, "Media", Migration0010],
] as const;

const TABLE = "toolreader_migrations";

/** Through `through` only: the upgrade tests build the schema an older toolreader left. */
const loader = (through: number | undefined) =>
  Migrator.fromRecord(
    Object.fromEntries(
      migrationEntries
        .filter(([id]) => through === undefined || id <= through)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

const runMigrator = Migrator.make({});

const Applied = Schema.Array(Schema.Struct({ id: Schema.Number, name: Schema.String }));
const decodeApplied = Schema.decodeUnknownEffect(Applied);

/**
 * Why this toolreader must not use a database migrated as `applied`, or null. A migration it
 * doesn't know means a newer toolreader migrated it: running would write rows that schema may not
 * accept, and it can't go back. A known id under another name means the history was edited.
 */
export function schemaProblem(
  applied: ReadonlyArray<{ readonly id: number; readonly name: string }>,
): string | null {
  const known = new Map<number, string>(migrationEntries.map(([id, name]) => [id, name]));
  const newest = Math.max(...known.keys());
  const newer = applied.filter((m) => m.id > newest);
  if (newer.length > 0)
    return `the history database is at schema ${Math.max(...newer.map((m) => m.id))}, newer than this toolreader knows (${newest}): upgrade toolreader`;
  const renamed = applied.find((m) => known.get(m.id) !== m.name);
  return renamed
    ? `the history database's migration ${renamed.id} is "${renamed.name}", not "${known.get(renamed.id)}": it was migrated by another build of toolreader`
    : null;
}

/**
 * Applies the migrations this database lacks, through `through` if given; returns them.
 *
 * Every command runs it, so concurrent hooks race it. The migrations table is locked for the
 * transaction (the Migrator locks it too), so one migrates and the rest wait, then find nothing to
 * do; a wait past `lock_timeout` fails rather than hangs a hook behind a long migration.
 */
export const migrate = Effect.fn("PgMigrations.migrate")(function* (
  options: { readonly through?: number } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        yield* sql`SET LOCAL lock_timeout = '10s'`;
        yield* sql`SET LOCAL statement_timeout = '5min'`;
        // As the Migrator would create it. Created here first: its own probe for the table fails,
        // which would abort this transaction.
        yield* sql`
          CREATE TABLE IF NOT EXISTS ${sql(TABLE)} (
            migration_id integer PRIMARY KEY,
            created_at timestamptz NOT NULL DEFAULT now(),
            name text NOT NULL
          )`;
        yield* sql`LOCK TABLE ${sql(TABLE)} IN ACCESS EXCLUSIVE MODE`;
        const applied = yield* sql`SELECT migration_id AS id, name FROM ${sql(TABLE)}`.pipe(
          Effect.flatMap(decodeApplied),
        );
        const problem = schemaProblem(applied);
        if (problem !== null) return yield* new HistoryStoreFailed({ message: problem });
        return yield* runMigrator({ loader: loader(options.through), table: TABLE });
      }),
    )
    .pipe(
      // The Migrator dies when a migration fails; that is still an error to report, not a crash.
      Effect.catchDefect((defect) =>
        defect instanceof Migrator.MigrationError ? Effect.fail(defect) : Effect.die(defect),
      ),
      Effect.catchTags({
        MigrationError: (e) =>
          Effect.fail(
            new HistoryStoreFailed({
              message: `Migrating the history database failed: ${e.message}${e.cause instanceof Error ? ` (${e.cause.message})` : ""}`,
            }),
          ),
        SqlError: (e) =>
          Effect.fail(
            new HistoryStoreFailed({
              message: `Migrating the history database failed: ${e.message}`,
            }),
          ),
        SchemaError: (e) => Effect.fail(new HistoryStoreFailed({ message: e.message })),
      }),
    );
});

// Two commands starting at once on a new database can both create the migrations table (`IF NOT
// EXISTS` checks, then creates); the one that loses finds it on its second try.
export const PgMigrationsLive = Layer.effectDiscard(migrate().pipe(Effect.retry({ times: 1 })));
