// Shapes of T3 `projection_thread_activities.payload_json` for tool rows, across providers.
// Every field is optional and nullable: providers fill different subsets. Polymorphic leaves stay
// `Unknown` and are decoded where they are used, so one odd field never drops a whole row.
import * as Schema from "effect/Schema";

const opt = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema));

/** Claude tool_result. */
export const ClaudeResult = Schema.Struct({
  content: opt(Schema.Unknown),
  is_error: opt(Schema.Boolean),
});
export type ClaudeResult = typeof ClaudeResult.Type;

/** Claude tool_result content: a string or `[{ type: "text", text }]`. */
export const ClaudeContent = Schema.Union([
  Schema.String,
  Schema.Array(Schema.Struct({ text: opt(Schema.String) })),
]);

const CodexChange = Schema.Struct({
  path: opt(Schema.String),
  diff: opt(Schema.String),
  kind: opt(Schema.Struct({ type: opt(Schema.String) })),
});

/** Codex app-server item (commandExecution, fileChange, mcpToolCall, webSearch, …). */
export const CodexItem = Schema.Struct({
  type: opt(Schema.String),
  command: opt(Schema.String),
  exitCode: opt(Schema.Number),
  aggregatedOutput: opt(Schema.String),
  commandActions: opt(Schema.Array(Schema.Struct({ type: opt(Schema.String) }))),
  changes: opt(Schema.Array(CodexChange)),
  server: opt(Schema.String),
  tool: opt(Schema.String),
  arguments: opt(Schema.Unknown),
  result: opt(Schema.Unknown),
  error: opt(Schema.Unknown),
  query: opt(Schema.String),
  action: opt(
    Schema.Struct({ type: opt(Schema.String), url: opt(Schema.String), query: opt(Schema.String) }),
  ),
  path: opt(Schema.String),
  prompt: opt(Schema.String),
  /** imageGeneration */
  revisedPrompt: opt(Schema.String),
  status: opt(Schema.String),
});
export type CodexItem = typeof CodexItem.Type;

/** Cursor (ACP) diff content block. */
const CursorContent = Schema.Struct({
  type: opt(Schema.String),
  path: opt(Schema.String),
  oldText: opt(Schema.String),
  newText: opt(Schema.String),
});

const ToolData = Schema.Struct({
  // Claude
  toolName: opt(Schema.String),
  input: opt(Schema.Record(Schema.String, Schema.Unknown)),
  result: opt(Schema.Unknown),
  // Codex
  item: opt(CodexItem),
  // Cursor
  toolCallId: opt(Schema.String),
  kind: opt(Schema.String),
  command: opt(Schema.String),
  rawInput: opt(Schema.Struct({ command: opt(Schema.String) })),
  rawOutput: opt(Schema.Unknown),
  content: opt(Schema.Array(CursorContent)),
});

export const ToolPayload = Schema.Struct({
  itemType: opt(Schema.String),
  toolCallId: opt(Schema.String),
  status: opt(Schema.String),
  title: opt(Schema.String),
  detail: opt(Schema.String),
  message: opt(Schema.String),
  data: opt(ToolData),
});
export type ToolPayload = typeof ToolPayload.Type;

/** Cursor rawOutput for commands and failures. */
export const CursorRawOutput = Schema.Struct({
  exitCode: opt(Schema.Number),
  stdout: opt(Schema.String),
  stderr: opt(Schema.String),
  error: opt(Schema.Unknown),
});
