import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

export class ServerConfig extends Context.Service<
  ServerConfig,
  {
    readonly port: number;
    readonly home: string;
    /** T3's database, opened read-only. */
    readonly dbPath: string;
    readonly codexBin: string;
    /** Codex's home: rollout files live in `sessions/` and `archived_sessions/` under it. */
    readonly codexHome: string;
    readonly labelsPath: string;
    /** Build output: the viewer in `client/`, the ledger site template in `site/`. */
    readonly distDir: string;
  }
>()("toolreader/server/ServerConfig") {
  static readonly layer = Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = yield* Config.string("HOME");
      return ServerConfig.of({
        port: yield* Config.port("PORT").pipe(Config.withDefault(4777)),
        home,
        dbPath: yield* Config.string("T3_DB").pipe(
          Config.withDefault(path.join(home, ".t3", "userdata", "state.sqlite")),
        ),
        codexBin: yield* Config.string("CODEX_BIN").pipe(Config.withDefault("codex")),
        codexHome: yield* Config.string("CODEX_HOME").pipe(
          Config.withDefault(path.join(home, ".codex")),
        ),
        labelsPath: yield* Config.string("TOOLREADER_LABELS").pipe(
          Config.withDefault(path.join(home, ".toolreader", "labels.json")),
        ),
        // Bundled, this module is dist/bin.mjs itself; in the repo it is src/server/ServerConfig.ts.
        distDir:
          path.basename(import.meta.dirname) === "dist"
            ? import.meta.dirname
            : path.join(import.meta.dirname, "..", "..", "dist"),
      });
    }),
  );
}
