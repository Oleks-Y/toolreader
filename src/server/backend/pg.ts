// The backend's Postgres pool, for `backend serve` and for the CLI without a backend.
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Config from "effect/Config";

/**
 * The pool at TOOLREADER_DATABASE_URL. A CLI command runs one query at a time (2), and gives up
 * on a database it can't reach in 5s rather than hang a git hook. The URL is redacted: it never
 * reaches logs or spans.
 */
export const pgLayer = (maxConnections: number) =>
  PgClient.layerConfig(
    Config.map(Config.redacted("TOOLREADER_DATABASE_URL"), (url) => ({
      url,
      applicationName: "toolreader",
      connectTimeout: "5 seconds",
      maxConnections,
    })),
  );
