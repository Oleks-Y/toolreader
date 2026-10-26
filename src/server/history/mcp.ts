// `toolreader mcp`: the history backend for agents, as an MCP server on stdio. `sql` runs the
// backend's `sql` endpoint (AgentSql.ts); `media` returns an image an entry cites as image
// content, so the agent sees the screenshot itself. Signed in as `history sql` is (HistoryClient).
// stdout carries the protocol, so logs go to stderr.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import { McpProtocol, McpSchema, McpServer, Tool, Toolkit } from "effect/unstable/ai";
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

// A raw tool: a Toolkit tool's result is always text, and this one's is the image.
const MediaToolLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const context = yield* Effect.context<
      ServerConfig | FileSystem.FileSystem | HttpClient.HttpClient
    >();
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: "media",
        title: "View an image from agent history",
        description:
          "An image an agent's tool returned (a screenshot it read, a video frame it checked), by the sha256 that agent_entries.media lists for it. Returns the image itself.",
        inputSchema: {
          type: "object",
          properties: { sha256: { type: "string", pattern: "^[0-9a-f]{64}$" } },
          required: ["sha256"],
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      }),
      annotations: Context.empty(),
      handle: (payload: { readonly sha256?: unknown }) =>
        Effect.gen(function* () {
          const sha256 = typeof payload.sha256 === "string" ? payload.sha256 : "";
          if (!/^[0-9a-f]{64}$/.test(sha256))
            return yield* new HistoryFailed({ message: "sha256 is 64 hex characters" });
          const settings = yield* backendSettings("reader");
          const api = yield* connect(settings);
          return yield* call(
            api.history.media({ params: { ws: settings.workspace }, payload: { sha256 } }),
          );
        }).pipe(
          Effect.provideContext(context),
          Effect.match({
            onFailure: (e) =>
              new McpSchema.CallToolResult({
                isError: true,
                content: [{ type: "text", text: e.message }],
              }),
            onSuccess: ({ mime, data }) =>
              new McpSchema.CallToolResult({
                content: [{ type: "image", mimeType: mime, data: Buffer.from(data, "base64") }],
              }),
          }),
        ),
    });
  }),
);

export const mcpCommand = Command.make("mcp", {}, () =>
  Layer.launch(
    Layer.merge(McpServer.toolkit(HistoryToolkit), MediaToolLive).pipe(
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
