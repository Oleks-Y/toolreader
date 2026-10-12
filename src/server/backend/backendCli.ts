// `toolreader backend`: the checkpoint backend (Backend.ts) and its admin, on the Postgres at
// TOOLREADER_DATABASE_URL, migrated on start.
//   toolreader backend serve [--port N]                       (default 4780, 127.0.0.1 only)
//   toolreader backend token create --workspace SLUG --name NAME
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

import { pgLayer } from "./pg.ts";
import { BackendServerLive } from "./Backend.ts";
import { CheckpointStore } from "./CheckpointStore.ts";
import { PgMigrationsLive } from "./PgMigrations.ts";

/** A workspace's slug is its `:ws` in every path: kept to what needs no escaping. */
const Slug = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/, {
    message: "a slug is 1–63 of a-z, 0-9 and -, starting with a letter or digit",
  }),
);

/** The store on a migrated database; the backend's pool serves concurrent requests. */
const BackendApp = CheckpointStore.layer.pipe(
  Layer.provideMerge(PgMigrationsLive),
  Layer.provideMerge(pgLayer(10)),
);

const serve = Command.make(
  "serve",
  {
    port: Flag.integer("port").pipe(
      Flag.withDescription("Port on 127.0.0.1"),
      Flag.withDefault(4780),
    ),
  },
  ({ port }) =>
    Effect.gen(function* () {
      yield* Effect.log(`toolreader backend → http://127.0.0.1:${port}/v1`);
      return yield* Layer.launch(BackendServerLive(port).pipe(Layer.provide(BackendApp)));
    }),
).pipe(Command.withDescription("Serve the checkpoint backend's /v1 API"));

const create = Command.make(
  "create",
  {
    workspace: Flag.string("workspace").pipe(
      Flag.withSchema(Slug),
      Flag.withDescription("The workspace's slug (created if new): a-z, 0-9 and -"),
    ),
    name: Flag.string("name").pipe(Flag.withDescription('Whose it is, e.g. "alex laptop"')),
  },
  Effect.fn("toolreader backend token create")(function* ({ workspace, name }) {
    const token = yield* Effect.flatMap(CheckpointStore, (s) =>
      s.createToken(workspace, name),
    ).pipe(Effect.provide(BackendApp));
    yield* Console.error(`Token "${name}" for workspace ${workspace}. It is shown only this once:`);
    yield* Console.log(token);
  }),
).pipe(Command.withDescription("Create an API token; prints it once"));

export const backendCommand = Command.make("backend").pipe(
  Command.withDescription("The checkpoint backend, on Postgres (TOOLREADER_DATABASE_URL)"),
  Command.withSubcommands([
    serve,
    Command.make("token").pipe(
      Command.withDescription("API tokens"),
      Command.withSubcommands([create]),
    ),
  ]),
);
