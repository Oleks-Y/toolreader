// Runs an agent's SQL (`POST /v1/workspaces/:ws/sql`) over one workspace's conversations. Each
// query gets a fresh connection as the workspace's agent login (Migrations/009: SELECT on the
// `agent_*` views, only its workspace's rows), in a READ ONLY transaction, through a cursor: the
// extended protocol takes one statement, so a query can't SET anything before it runs. Rows and
// bytes are capped, and the backend gives up on a query past the timeout whatever the session says.
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import type * as SqlError from "effect/unstable/sql/SqlError";
import * as PgClient from "@effect/sql-pg/PgClient";

import { HistoryStore, HistoryStoreFailed, type AgentLogin } from "./HistoryStore.ts";

/** Postgres refused the query (its syntax, a permission, the timeout): the caller's to fix. */
export class AgentQueryFailed extends Schema.TaggedErrorClass<AgentQueryFailed>()(
  "AgentQueryFailed",
  { message: Schema.String },
) {}

export type AgentRows = {
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  /** More rows than `limits.rows`, or more bytes than `limits.bytes`: the rest were dropped. */
  readonly truncated: boolean;
};

const RowJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const toJson = Schema.encodeSync(RowJson);
const fromJson = Schema.decodeSync(RowJson);

export const AGENT_LIMITS = {
  rows: 1000,
  /** Of the rows as JSON. */
  bytes: 1024 * 1024,
  timeout: Duration.seconds(10),
};

/** Postgres' own words for a query it refused; null for the connection or sign-in failing. */
const refusal = (e: SqlError.SqlError): string | null => {
  const pg = e.reason.cause;
  if (!Predicate.hasProperty(pg, "code") || !Predicate.isString(pg.code)) return null;
  if (/^(?:08|28)/.test(pg.code)) return null;
  return Predicate.hasProperty(pg, "message") && Predicate.isString(pg.message)
    ? pg.message
    : `SQLSTATE ${pg.code}`;
};

export class AgentSql extends Context.Service<
  AgentSql,
  {
    readonly query: (
      workspaceId: string,
      text: string,
    ) => Effect.Effect<AgentRows, AgentQueryFailed | HistoryStoreFailed>;
  }
>()("toolreader/server/backend/AgentSql") {
  static readonly layer = (limits: typeof AGENT_LIMITS = AGENT_LIMITS) =>
    Layer.effect(
      AgentSql,
      Effect.gen(function* () {
        const store = yield* HistoryStore;
        const owner = yield* PgClient.PgClient;

        // The backend's own connection settings, signed in as `login`. A URL's user wins over
        // `username` in node-postgres, so the URL is rewritten instead.
        const as = (login: AgentLogin): PgClient.PgClientConfig => {
          const { url, ...rest } = owner.config;
          const password = Redacted.make(login.password);
          if (url === undefined) return { ...rest, username: login.role, password };
          const u = new URL(Redacted.value(url));
          u.username = login.role;
          u.password = login.password;
          return { ...rest, url: Redacted.make(u.toString()) };
        };

        const run = (login: AgentLogin, text: string) =>
          Effect.gen(function* () {
            // ponytail: a connection per query; pool per login if agents query in bulk.
            const client = yield* PgClient.make({
              ...as(login),
              applicationName: "toolreader-agent",
              connectTimeout: "5 seconds",
              maxConnections: 1,
            });
            return yield* client.withTransaction(
              Effect.gen(function* () {
                yield* client`SET TRANSACTION READ ONLY`;
                yield* client.unsafe(
                  `SET LOCAL statement_timeout = ${Duration.toMillis(limits.timeout)}`,
                );
                // ponytail: one row is held whole however big; Postgres caps a value at 1 GB.
                const fetched = yield* client
                  .unsafe<Record<string, unknown>>(text)
                  .stream.pipe(Stream.take(limits.rows + 1), Stream.runCollect);
                // Through JSON as sent, so the byte cap counts what goes out: dates as strings.
                const rows: Array<Record<string, unknown>> = [];
                let bytes = 0;
                for (const row of fetched.slice(0, limits.rows)) {
                  const json = toJson(row);
                  bytes += json.length;
                  if (bytes > limits.bytes) break;
                  rows.push(fromJson(json));
                }
                return { rows, truncated: rows.length < fetched.length };
              }),
            );
          }).pipe(Effect.scoped, Effect.provide(Reactivity.layer));

        const query = Effect.fn("AgentSql.query")(function* (workspaceId: string, text: string) {
          const login = yield* store.agentLogin(workspaceId);
          return yield* run(login, text).pipe(
            Effect.catchTag("SqlError", (e) => {
              const message = refusal(e);
              return Effect.fail(
                message === null
                  ? new HistoryStoreFailed({ message: `The agent login failed: ${e.message}` })
                  : new AgentQueryFailed({ message }),
              );
            }),
            // Past the statement timeout, if the session still got around it.
            Effect.timeoutOrElse({
              duration: Duration.sum(limits.timeout, Duration.seconds(5)),
              orElse: () =>
                Effect.fail(
                  new AgentQueryFailed({
                    message: `The query ran past ${Duration.format(limits.timeout)}`,
                  }),
                ),
            }),
          );
        });

        return AgentSql.of({ query });
      }),
    );
}
