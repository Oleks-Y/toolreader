import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

export class ServerConfig extends Context.Service<
  ServerConfig,
  {
    readonly port: number;
    readonly home: string;
    /** T3's database, opened read-only: `statev2.sqlite` where T3 has moved to it, else `state.sqlite`. */
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
      const fs = yield* FileSystem.FileSystem;
      const home = yield* Config.string("HOME");
      // T3 0.0.46 nightlies (orchestration V2) write statev2.sqlite and leave state.sqlite behind.
      const userdata = path.join(home, ".t3", "userdata");
      const v2Db = path.join(userdata, "statev2.sqlite");
      const hasV2 = yield* fs.exists(v2Db).pipe(Effect.orElseSucceed(() => false));
      return ServerConfig.of({
        port: yield* Config.port("PORT").pipe(Config.withDefault(4777)),
        home,
        dbPath: yield* Config.string("T3_DB").pipe(
          Config.withDefault(hasV2 ? v2Db : path.join(userdata, "state.sqlite")),
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
