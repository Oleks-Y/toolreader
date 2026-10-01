import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CodexSessions } from "./CodexSessions.ts";
import { HttpServerLive } from "./http.ts";
import { Labeler } from "./Labeler.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";
import { ServerConfig } from "./ServerConfig.ts";
import { ThreadStore } from "./ThreadStore.ts";

const SqlLive = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    return NodeSqliteClient.layer({ filename: dbPath, readonly: true });
  }),
);

const Announce = Layer.effectDiscard(
  Effect.gen(function* () {
    const { port, dbPath } = yield* ServerConfig;
    yield* Effect.log(`toolreader → http://127.0.0.1:${port}  (reading ${dbPath})`);
  }),
);

const MainLive = Layer.mergeAll(HttpServerLive, Announce).pipe(
  Layer.provide(Layer.mergeAll(CodexSessions.layer, Labeler.layer)),
  Layer.provideMerge(ThreadStore.layer),
  Layer.provide(SqlLive),
  Layer.provideMerge(ServerConfig.layer),
  Layer.provide(NodeServices.layer),
);

Layer.launch(MainLive).pipe(NodeRuntime.runMain);
