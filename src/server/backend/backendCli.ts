// `toolreader backend`: the history backend (Backend.ts) and its admin, on the Postgres at
// TOOLREADER_DATABASE_URL, migrated on start.
//   toolreader backend serve [--port N]                       (default 4780, 127.0.0.1 only)
//   toolreader backend token create --workspace SLUG --name NAME
//   toolreader backend member add --workspace SLUG --github LOGIN
// GitHub sign-in is on when TOOLREADER_GITHUB_CLIENT_ID names the OAuth or GitHub App people sign
// in through (TOOLREADER_GITHUB_API and TOOLREADER_GITHUB_WEB for GitHub Enterprise).
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { pgLayer } from "./pg.ts";
import { BackendServerLive } from "./Backend.ts";
import { GitHub } from "./GitHub.ts";
import { HistoryStore } from "./HistoryStore.ts";
import { PgMigrationsLive } from "./PgMigrations.ts";

/** A workspace's slug is its `:ws` in every path: kept to what needs no escaping. */
const Slug = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/, {
    message: "a slug is 1–63 of a-z, 0-9 and -, starting with a letter or digit",
  }),
);

/** GitHub sign-in, when the environment names a client id; off otherwise. */
const GitHubLive = Layer.unwrap(
  Effect.gen(function* () {
    const clientId = yield* Config.string("TOOLREADER_GITHUB_CLIENT_ID").pipe(Config.option);
    if (clientId._tag === "None") return GitHub.disabled;
    const apiUrl = yield* Config.string("TOOLREADER_GITHUB_API").pipe(
      Config.withDefault("https://api.github.com"),
    );
    const webUrl = yield* Config.string("TOOLREADER_GITHUB_WEB").pipe(
      Config.withDefault("https://github.com"),
    );
    return GitHub.layer({ clientId: clientId.value, apiUrl, webUrl }).pipe(
      Layer.provide(FetchHttpClient.layer),
    );
  }),
);

/** The store on a migrated database; the backend's pool serves concurrent requests. */
const BackendApp = HistoryStore.layer.pipe(
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
      return yield* Layer.launch(
        BackendServerLive(port).pipe(Layer.provide([BackendApp, GitHubLive])),
      );
    }),
).pipe(Command.withDescription("Serve the history backend's /v1 API"));

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
    const token = yield* Effect.flatMap(HistoryStore, (s) => s.createToken(workspace, name)).pipe(
      Effect.provide(BackendApp),
    );
    yield* Console.error(`Token "${name}" for workspace ${workspace}. It is shown only this once:`);
    yield* Console.log(token);
  }),
).pipe(Command.withDescription("Create an API token; prints it once"));

const addMember = Command.make(
  "add",
  {
    workspace: Flag.string("workspace").pipe(
      Flag.withSchema(Slug),
      Flag.withDescription("The workspace's slug (created if new)"),
    ),
    github: Flag.string("github").pipe(Flag.withDescription("Their GitHub login")),
  },
  Effect.fn("toolreader backend member add")(function* ({ workspace, github }) {
    yield* Effect.flatMap(HistoryStore, (s) => s.addMember(workspace, github)).pipe(
      Effect.provide(BackendApp),
    );
    yield* Console.log(
      `${github} can sign in to ${workspace} with GitHub, and read the repos GitHub lets them read.`,
    );
  }),
).pipe(Command.withDescription("Let a GitHub login sign in to the workspace"));

export const backendCommand = Command.make("backend").pipe(
  Command.withDescription("The history backend, on Postgres (TOOLREADER_DATABASE_URL)"),
  Command.withSubcommands([
    serve,
    Command.make("token").pipe(
      Command.withDescription("API tokens"),
      Command.withSubcommands([create]),
    ),
    Command.make("member").pipe(
      Command.withDescription("Who may sign in with GitHub"),
      Command.withSubcommands([addMember]),
    ),
  ]),
);
