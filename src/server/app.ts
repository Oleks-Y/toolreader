// Service wiring shared by the HTTP server (`serve`) and the other commands of bin.ts.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { BackendSink, backendSettings } from "./checkpoints/BackendClient.ts";
import { CheckpointFailed, Checkpoints } from "./checkpoints/Checkpoints.ts";
import { DirectSink } from "./directSink.ts";
import { CheckpointStore } from "./backend/CheckpointStore.ts";
import { pgLayer } from "./backend/pg.ts";
import { ClaudeTranscripts } from "./ClaudeTranscripts.ts";
import { CodexRollouts } from "./CodexRollouts.ts";
import { CodexSessions } from "./CodexSessions.ts";
import { Labeler } from "./Labeler.ts";
import { Ledger } from "./Ledger.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";
import { PgMigrationsLive } from "./backend/PgMigrations.ts";
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
      Layer.mergeAll(
        codexSessions,
        CodexRollouts.layer,
        ClaudeTranscripts.layer,
        Labeler.layer,
        Sanitizer.layer,
      ),
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

/**
 * Where checkpoints go: the backend configured in ~/.toolreader/config.json (or the environment);
 * without one, Postgres at TOOLREADER_DATABASE_URL directly, migrated on start.
 */
const SinkLive = Layer.unwrap(
  Effect.gen(function* () {
    const settings = yield* backendSettings();
    if (settings) return BackendSink(settings);
    if (Option.isNone(yield* Config.option(Config.string("TOOLREADER_DATABASE_URL"))))
      return yield* new CheckpointFailed({
        message:
          "No checkpoint backend: set backend.url, backend.token and backend.workspace in ~/.toolreader/config.json",
      });
    return DirectSink.pipe(
      Layer.provideMerge(CheckpointStore.layer),
      Layer.provideMerge(PgMigrationsLive),
      Layer.provideMerge(pgLayer(2)),
    );
  }),
);

/** For `toolreader checkpoint`: the ledger's readers, and where checkpoints go. */
export const CheckpointApp = (options: { appServer: boolean } = { appServer: false }) =>
  Checkpoints.layer.pipe(
    Layer.provideMerge(SinkLive),
    Layer.provideMerge(LedgerApp({ appServer: options.appServer, codexHome: null })),
  );
