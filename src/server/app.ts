// Service wiring shared by the HTTP server (bin.ts) and the export CLI (export.ts).
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CodexSessions } from "./CodexSessions.ts";
import { Labeler } from "./Labeler.ts";
import { Ledger } from "./Ledger.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";
import { Proofs } from "./Proofs.ts";
import { ServerConfig } from "./ServerConfig.ts";
import { ThreadStore } from "./ThreadStore.ts";

const SqlLive = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    return NodeSqliteClient.layer({ filename: dbPath, readonly: true });
  }),
);

/** Every app service, plus the Node platform services they run on. */
export const AppLive = Layer.mergeAll(Proofs.layer, Ledger.layer).pipe(
  Layer.provideMerge(Layer.mergeAll(CodexSessions.layer, Labeler.layer)),
  Layer.provideMerge(ThreadStore.layer),
  Layer.provide(SqlLive),
  Layer.provideMerge(ServerConfig.layer),
  Layer.provideMerge(NodeServices.layer),
);
