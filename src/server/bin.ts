// The `toolreader` CLI: `serve` (the viewer), `ledger sync|show|site|hook`, `export`.
// Published bundled (`vp pack` → dist/bin.mjs); in this repo, `node src/server/bin.ts <command>`.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/unstable/cli";

import packageJson from "../../package.json" with { type: "json" };
import { AppLive } from "./app.ts";
import { exportCommand } from "./export.ts";
import { HttpServerLive } from "./http.ts";
import { ledgerCommand } from "./ledgerCli.ts";
import { ServerConfig } from "./ServerConfig.ts";

const Announce = Layer.effectDiscard(
  Effect.gen(function* () {
    const { port, dbPath } = yield* ServerConfig;
    yield* Effect.log(`toolreader → http://127.0.0.1:${port}  (reading ${dbPath})`);
  }),
);

const serve = Command.make("serve", {}, () =>
  Layer.launch(Layer.mergeAll(HttpServerLive, Announce).pipe(Layer.provide(AppLive))),
).pipe(
  Command.withDescription(
    "Serve the viewer on http://127.0.0.1:$PORT (default 4777): T3 and Codex sessions, and #/ledger",
  ),
);

Command.make("toolreader").pipe(
  Command.withDescription("What coding agents did: sessions, and agent history per commit"),
  Command.withSubcommands([serve, ledgerCommand, exportCommand]),
  Command.run({ version: packageJson.version }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
