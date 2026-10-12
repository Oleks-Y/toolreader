// The history backend's Postgres pool (`backend serve`, `backend token`).
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Config from "effect/Config";

/**
 * The pool at TOOLREADER_DATABASE_URL, giving up on a database it can't reach in 5s. The URL is
 * redacted: it never reaches logs or spans.
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
