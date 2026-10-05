// Service wiring shared by the HTTP server (`serve`) and the other commands of bin.ts.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { CodexRollouts } from "./CodexRollouts.ts";
import { CodexSessions } from "./CodexSessions.ts";
import { Labeler } from "./Labeler.ts";
import { Ledger } from "./Ledger.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";
import { Proofs } from "./Proofs.ts";
import { Sanitizer } from "./Sanitizer.ts";
import { ServerConfig } from "./ServerConfig.ts";
import { ThreadStore } from "./ThreadStore.ts";

/** T3's threads, or none when its database doesn't exist (CI, machines without T3). */
const ThreadStoreLive = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    if (yield* fs.exists(dbPath).pipe(Effect.orElseSucceed(() => false))) {
      return ThreadStore.layer.pipe(
        Layer.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })),
      );
    }
    yield* Effect.logWarning(`No T3 database at ${dbPath}: T3 threads are not listed`);
    return ThreadStore.empty;
  }),
);

/** The configuration, with `codexHome` replaced when a CLI flag gives one. */
const configLayer = (codexHome: string | null) =>
  codexHome === null
    ? ServerConfig.layer
    : Layer.effect(
        ServerConfig,
        Effect.gen(function* () {
          return ServerConfig.of({ ...(yield* ServerConfig), codexHome });
        }),
      ).pipe(Layer.provide(ServerConfig.layer));

const appLayer = <R>(
  codexSessions: Layer.Layer<CodexSessions, never, R>,
  codexHome: string | null = null,
) =>
  Layer.mergeAll(Proofs.layer, Ledger.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(codexSessions, CodexRollouts.layer, Labeler.layer, Sanitizer.layer),
    ),
    Layer.provideMerge(ThreadStoreLive),
    Layer.provideMerge(configLayer(codexHome)),
    Layer.provideMerge(NodeServices.layer),
  );

/** Every app service, plus the Node platform services they run on. */
export const AppLive = appLayer(CodexSessions.layer);

/** For the ledger CLI: starts `codex app-server` only when asked to read from it. */
export const LedgerApp = (options: { appServer: boolean; codexHome: string | null }) =>
  options.appServer
    ? appLayer(CodexSessions.layer, options.codexHome)
    : appLayer(CodexSessions.disabled, options.codexHome);
