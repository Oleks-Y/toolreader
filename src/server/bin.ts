import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AppLive } from "./app.ts";
import { HttpServerLive } from "./http.ts";
import { ServerConfig } from "./ServerConfig.ts";

const Announce = Layer.effectDiscard(
  Effect.gen(function* () {
    const { port, dbPath } = yield* ServerConfig;
    yield* Effect.log(`toolreader → http://127.0.0.1:${port}  (reading ${dbPath})`);
  }),
);

Layer.launch(Layer.mergeAll(HttpServerLive, Announce).pipe(Layer.provide(AppLive))).pipe(
  NodeRuntime.runMain,
);
