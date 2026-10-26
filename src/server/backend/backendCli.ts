// `toolreader backend`: the history backend (Backend.ts) and its admin, on the Postgres at
// TOOLREADER_DATABASE_URL, migrated on start.
//   toolreader backend serve [--port N]                       (default 4780, 127.0.0.1 only)
//   toolreader backend token create --workspace SLUG --name NAME
//   toolreader backend token revoke --workspace SLUG --name NAME
//   toolreader backend member add|remove --workspace SLUG --github LOGIN
//   toolreader backend thread delete --workspace SLUG --id THREAD
//   toolreader backend media enable|disable --workspace SLUG
// TOOLREADER_RETENTION_DAYS, when set, removes threads stored longer ago than that, hourly.
// Images are kept in the S3-compatible bucket TOOLREADER_MEDIA_* names (MediaBucket.ts), for the
// workspaces that enable media; the hourly sweep removes those no thread cites.
// GitHub sign-in is on when TOOLREADER_GITHUB_CLIENT_ID names the OAuth or GitHub App people sign
// in through (TOOLREADER_GITHUB_API and TOOLREADER_GITHUB_WEB for GitHub Enterprise).
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { pgLayer } from "./pg.ts";
import { BackendServerLive } from "./Backend.ts";
import { GitHub } from "./GitHub.ts";
import { HistoryStore } from "./HistoryStore.ts";
import { MediaBucket, mediaKey } from "./MediaBucket.ts";
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
const BackendApp = Layer.merge(HistoryStore.layer, MediaBucket.layerConfig).pipe(
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
      const days = yield* Config.int("TOOLREADER_RETENTION_DAYS").pipe(Config.option);
      const server = Layer.launch(BackendServerLive(port).pipe(Layer.provide(GitHubLive)));
      // Hourly, and once at start; a failed sweep is logged and tried again next hour. Retention
      // first, so the images of threads it removed go in the same pass.
      const expire = Effect.gen(function* () {
        if (days._tag === "None") return;
        const n = yield* Effect.flatMap(HistoryStore, (s) => s.expire(days.value));
        if (n > 0) yield* Effect.log(`retention: ${n} threads expired`);
      });
      const sweepMedia = Effect.gen(function* () {
        const store = yield* HistoryStore;
        const bucket = yield* MediaBucket;
        if (!bucket.config) return;
        const orphans = yield* store.orphanMedia;
        for (const { workspaceId, sha256 } of orphans) {
          yield* bucket.remove(mediaKey(workspaceId, sha256));
          yield* store.dropMedia(workspaceId, sha256);
        }
        if (orphans.length > 0) yield* Effect.log(`media: ${orphans.length} images removed`);
      });
      const sweep = Effect.andThen(expire, sweepMedia).pipe(
        Effect.catchTags({
          HistoryStoreFailed: (e) => Effect.logWarning(`sweep: ${e.message}`),
          MediaBucketFailed: (e) => Effect.logWarning(`sweep: ${e.message}`),
        }),
        Effect.repeat(Schedule.spaced("1 hour")),
      );
      return yield* Effect.all([server, sweep], { concurrency: 2, discard: true }).pipe(
        Effect.provide(BackendApp),
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

const revoke = Command.make(
  "revoke",
  {
    workspace: Flag.string("workspace").pipe(Flag.withSchema(Slug)),
    name: Flag.string("name").pipe(Flag.withDescription("The name it was created with")),
  },
  Effect.fn("toolreader backend token revoke")(function* ({ workspace, name }) {
    const n = yield* Effect.flatMap(HistoryStore, (s) => s.revokeToken(workspace, name)).pipe(
      Effect.provide(BackendApp),
    );
    yield* Console.log(`${n} token${n === 1 ? "" : "s"} named "${name}" revoked in ${workspace}`);
  }),
).pipe(Command.withDescription("Revoke a workspace's tokens by name: they stop working at once"));

const deleteThread = Command.make(
  "delete",
  {
    workspace: Flag.string("workspace").pipe(Flag.withSchema(Slug)),
    id: Flag.string("id").pipe(Flag.withDescription("The thread, as its citations name it")),
  },
  Effect.fn("toolreader backend thread delete")(function* ({ workspace, id }) {
    const had = yield* Effect.flatMap(HistoryStore, (s) => s.deleteThread(workspace, id)).pipe(
      Effect.provide(BackendApp),
    );
    yield* Console.log(
      `${id} ${had ? "deleted" : "wasn't stored; marked deleted"} in ${workspace}: citations of it read "deleted", and no sync stores it again`,
    );
  }),
).pipe(
  Command.withDescription(
    "Delete a thread on request: its history, search hits and findings' citations of it",
  ),
);

const removeMember = Command.make(
  "remove",
  {
    workspace: Flag.string("workspace").pipe(Flag.withSchema(Slug)),
    github: Flag.string("github").pipe(Flag.withDescription("Their GitHub login")),
  },
  Effect.fn("toolreader backend member remove")(function* ({ workspace, github }) {
    const was = yield* Effect.flatMap(HistoryStore, (s) => s.removeMember(workspace, github)).pipe(
      Effect.provide(BackendApp),
    );
    yield* Console.log(
      was
        ? `${github} can no longer sign in to ${workspace}`
        : `${github} wasn't a member of ${workspace}`,
    );
  }),
).pipe(Command.withDescription("Stop a GitHub login signing in to the workspace"));

const mediaSwitch = (on: boolean) =>
  Command.make(
    on ? "enable" : "disable",
    {
      workspace: Flag.string("workspace").pipe(
        Flag.withSchema(Slug),
        Flag.withDescription("The workspace's slug (created if new)"),
      ),
    },
    Effect.fn(`toolreader backend media ${on ? "enable" : "disable"}`)(function* ({ workspace }) {
      const configured = yield* Effect.gen(function* () {
        yield* Effect.flatMap(HistoryStore, (s) => s.setMedia(workspace, on));
        return (yield* MediaBucket).config !== null;
      }).pipe(Effect.provide(BackendApp));
      yield* Console.log(
        on
          ? `${workspace} keeps the images its sessions' tools returned${configured ? "" : " (once TOOLREADER_MEDIA_* names a bucket)"}.`
          : `${workspace} no longer keeps images; the next sweep removes those it holds.`,
      );
    }),
  ).pipe(
    Command.withDescription(
      on
        ? "Keep screenshots agents looked at: sync and push send them, agents read them over MCP. Pixels can't be redacted"
        : "Stop keeping images, and remove those held at the next sweep",
    ),
  );

export const backendCommand = Command.make("backend").pipe(
  Command.withDescription("The history backend, on Postgres (TOOLREADER_DATABASE_URL)"),
  Command.withSubcommands([
    serve,
    Command.make("token").pipe(
      Command.withDescription("API tokens"),
      Command.withSubcommands([create, revoke]),
    ),
    Command.make("member").pipe(
      Command.withDescription("Who may sign in with GitHub"),
      Command.withSubcommands([addMember, removeMember]),
    ),
    Command.make("thread").pipe(
      Command.withDescription("Stored threads"),
      Command.withSubcommands([deleteThread]),
    ),
    Command.make("media").pipe(
      Command.withDescription("Whether a workspace keeps images (off by default)"),
      Command.withSubcommands([mediaSwitch(true), mediaSwitch(false)]),
    ),
  ]),
);
