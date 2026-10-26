// `toolreader mcp`: the history backend for agents, as an MCP server on stdio. One tool, `sql`,
// over the backend's `sql` endpoint (AgentSql.ts), signed in as `history sql` is (HistoryClient).
// stdout carries the protocol, so logs go to stderr.
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/unstable/ai";
import { Command } from "effect/unstable/cli";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as NodeStdio from "@effect/platform-node/NodeStdio";

import packageJson from "../../../package.json" with { type: "json" };
import { AGENT_SCHEMA, LIMITS, SqlResult } from "../../core/historyApi.ts";
import { ServerConfig } from "../ServerConfig.ts";
import { backendSettings, call, connect, HistoryFailed } from "./HistoryClient.ts";

const SqlTool = Tool.make("sql", {
  description: AGENT_SCHEMA,
  parameters: Schema.Struct({
    query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(LIMITS.sql)),
  }),
  success: SqlResult,
  failure: HistoryFailed,
})
  .annotate(Tool.Title, "Query agent history")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const HistoryToolkit = Toolkit.make(SqlTool);

// Settings are read per call: a backend set up after the agent started still works, and a
// missing one is the tool's error, not a server that never starts.
const HandlersLive = HistoryToolkit.toLayer(
  Effect.gen(function* () {
    const context = yield* Effect.context<
      ServerConfig | FileSystem.FileSystem | HttpClient.HttpClient
    >();
    return {
      sql: ({ query }) =>
        Effect.gen(function* () {
          const settings = yield* backendSettings("reader");
          const api = yield* connect(settings);
          return yield* call(
            api.history.sql({ params: { ws: settings.workspace }, payload: { query } }),
          );
        }).pipe(Effect.provideContext(context)),
    };
  }),
);

export const mcpCommand = Command.make("mcp", {}, () =>
  Layer.launch(
    McpServer.toolkit(HistoryToolkit).pipe(
      Layer.provide(HandlersLive),
      Layer.provide(
        McpServer.layerStdio({
          name: "toolreader",
          version: packageJson.version,
          protocols: [McpProtocol.v2025_06_18],
        }),
      ),
      Layer.provide([NodeStdio.layer, FetchHttpClient.layer, ServerConfig.layer]),
    ),
  ).pipe(Effect.provide(Logger.layer([Logger.withConsoleError(Logger.formatSimple)]))),
).pipe(
  Command.withDescription(
    "Serve agent history to agents over MCP (stdio): read-only SQL over the workspace's conversations",
  ),
);
