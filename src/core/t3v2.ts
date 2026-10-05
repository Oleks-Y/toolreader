// T3's orchestration V2 turn items (`orchestration_v2_projection_turn_items`, T3 0.0.46 nightlies on)
// as the V1-shaped rows `normalize` already understands, like codex.ts does for Codex items.
// Adapters fill different fields and V2 is still moving, so items decode loosely: an odd item
// degrades to an untyped row instead of hiding the thread.
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import type { ActivityRow, MessageRow } from "./normalize.ts";
import type { ToolPayload } from "./payload.ts";

const opt = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema));

const TurnItem = Schema.Struct({
  title: opt(Schema.String),
  startedAt: opt(Schema.String),
  /** user_message, assistant_message, reasoning */
  text: opt(Schema.String),
  /** command_execution: the command line; dynamic_tool: the tool's arguments. */
  input: opt(Schema.Unknown),
  output: opt(Schema.Unknown),
  exitCode: opt(Schema.Number),
  toolName: opt(Schema.String),
  /** file_change. Claude puts its tool result (JSON) in `diffStr`; others a unified diff. */
  fileName: opt(Schema.String),
  diffStr: opt(Schema.String),
  oldStr: opt(Schema.String),
  newStr: opt(Schema.String),
  changes: opt(Schema.Array(Schema.Struct({ operation: opt(Schema.String) }))),
  /** file_search, web_search */
  pattern: opt(Schema.String),
  patterns: opt(Schema.Array(Schema.String)),
  results: opt(
    Schema.Array(
      Schema.Struct({
        fileName: opt(Schema.String),
        line: opt(Schema.Number),
        preview: opt(Schema.String),
        title: opt(Schema.String),
        url: opt(Schema.String),
        snippet: opt(Schema.String),
      }),
    ),
  ),
  /** subagent */
  prompt: opt(Schema.String),
  result: opt(Schema.String),
  /** user_input_request */
  questions: opt(Schema.Array(Schema.Unknown)),
  questionAnswer: opt(Schema.Unknown),
  /** error */
  failure: opt(Schema.Struct({ message: opt(Schema.String) })),
});
type TurnItem = typeof TurnItem.Type;
const decodeTurnItem = Schema.decodeUnknownOption(Schema.fromJsonString(TurnItem));

/** Claude's Edit / Write tool result, as `diffStr` carries it. */
const ClaudeFileResult = Schema.Struct({
  type: opt(Schema.String),
  filePath: opt(Schema.String),
  content: opt(Schema.String),
  oldString: opt(Schema.String),
  newString: opt(Schema.String),
});
const decodeClaudeFileResult = Schema.decodeUnknownOption(Schema.fromJsonString(ClaudeFileResult));

/** The columns ThreadStore reads for one turn item. */
export type TurnItemRow = {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly ordinal: number;
  readonly updatedAt: string;
  readonly payload: string;
};

/** T3 copies V1 transcripts into V2 under this id prefix; the V1 tables keep the full history. */
export const IMPORTED_ITEM_PREFIX = "migration:v1:";

/** Item types that become actions, for counting them without decoding payloads. */
export const ACTION_ITEM_TYPES = [
  "command_execution",
  "dynamic_tool",
  "file_change",
  "file_search",
  "web_search",
  "subagent",
  "user_input_request",
];

const MESSAGE_ROLES: Record<string, string> = {
  user_message: "user",
  assistant_message: "assistant",
  reasoning: "reasoning",
};

const text = (v: unknown): string | undefined =>
  v === undefined || v === null ? undefined : Predicate.isString(v) ? v : JSON.stringify(v);

const toolStatus = (s: string) =>
  s === "completed"
    ? "completed"
    : s === "failed" || s === "cancelled" || s === "interrupted"
      ? "failed"
      : "inProgress";

/** A result in the Claude tool_result shape `normalize` reads output and errors from. */
const result = (content: unknown, failed: boolean) =>
  content === undefined && !failed ? undefined : { content: text(content), is_error: failed };

function toolData(type: string, item: TurnItem, failed: boolean): ToolPayload["data"] {
  switch (type) {
    case "command_execution": {
      const output = text(item.output);
      // Claude reports a nonzero exit only in the output text.
      const parsed = /^(?:Error: )?Exit code (\d+)/.exec(output ?? "")?.[1];
      return {
        item: {
          type: "commandExecution",
          command: text(item.input),
          aggregatedOutput: output,
          exitCode: item.exitCode ?? (parsed ? Number(parsed) : undefined),
        },
      };
    }
    case "file_change": {
      const path = item.fileName ?? "?";
      const claude = Option.getOrUndefined(decodeClaudeFileResult(item.diffStr ?? ""));
      if (claude?.filePath) {
        return claude.content !== undefined && claude.content !== null
          ? {
              toolName: "Write",
              input: { file_path: claude.filePath, content: claude.content },
              result: { content: claude.type === "create" ? "File created" : "" },
            }
          : {
              toolName: "Edit",
              input: {
                file_path: claude.filePath,
                old_string: claude.oldString ?? "",
                new_string: claude.newString ?? "",
              },
            };
      }
      // A failed Claude edit carries its error text, not a diff.
      if (failed)
        return { toolName: "Edit", input: { file_path: path }, result: result(item.diffStr, true) };
      if (item.diffStr) {
        const op = item.changes?.[0]?.operation ?? "";
        const kind = /add|create/.test(op) ? "add" : /delete|remove/.test(op) ? "delete" : "update";
        return { item: { changes: [{ path, diff: item.diffStr, kind: { type: kind } }] } };
      }
      return {
        content: [{ type: "diff", path, oldText: item.oldStr, newText: item.newStr ?? "" }],
      };
    }
    case "dynamic_tool":
      return {
        toolName: item.toolName,
        input: Predicate.isObject(item.input) ? (item.input as Record<string, unknown>) : {},
        result: result(item.output, failed),
      };
    case "file_search":
      return {
        toolName: "Grep",
        input: { pattern: item.pattern },
        result: result(
          item.results
            ?.map((r) => [r.fileName, r.line, r.preview].filter((x) => x != null).join(":"))
            .join("\n"),
          failed,
        ),
      };
    case "web_search": {
      const pattern = item.patterns?.[0] ?? "";
      const out = item.results
        ?.map((r) => [r.title, r.url, r.snippet].filter(Boolean).join("\n"))
        .join("\n\n");
      // Claude's WebFetch is a web_search whose pattern is the URL.
      return /^https?:\/\//.test(pattern)
        ? { toolName: "WebFetch", input: { url: pattern }, result: result(out, failed) }
        : { toolName: "WebSearch", input: { query: pattern }, result: result(out, failed) };
    }
    case "subagent":
      return {
        toolName: "Agent",
        input: { description: item.title, prompt: item.prompt },
        result: result(item.result, failed),
      };
    case "user_input_request":
      return {
        toolName: "AskUserQuestion",
        input: { questions: item.questions },
        result: result(item.questionAnswer, failed),
      };
    default:
      return undefined;
  }
}

/** Turns V2 turn items, in ordinal order, into activity and message rows. Imported V1 items are skipped. */
export function turnItemsToRows(rows: ReadonlyArray<TurnItemRow>): {
  activities: ActivityRow[];
  messages: MessageRow[];
} {
  const activities: ActivityRow[] = [];
  const messages: MessageRow[] = [];
  for (const row of rows) {
    if (row.id.startsWith(IMPORTED_ITEM_PREFIX)) continue;
    const item = Option.getOrElse(decodeTurnItem(row.payload), (): TurnItem => ({}));
    const at = item.startedAt ?? row.updatedAt;
    const seq = row.ordinal;
    const role = MESSAGE_ROLES[row.type];
    if (role) {
      messages.push({ id: row.id, at, seq, role, text: item.text ?? "" });
    } else if (row.type === "error") {
      activities.push({
        id: row.id,
        at,
        seq,
        kind: "runtime.error",
        tone: "error",
        summary: "Runtime error",
        payload: { detail: item.failure?.message },
      });
    } else if (row.type === "compaction") {
      activities.push({
        id: row.id,
        at,
        seq,
        kind: "context-compaction",
        tone: "info",
        summary: "Context compacted",
        payload: {},
      });
    } else if (ACTION_ITEM_TYPES.includes(row.type)) {
      const status = toolStatus(row.status);
      activities.push({
        id: row.id,
        at,
        seq,
        kind: "tool.completed",
        tone: "tool",
        summary: item.title ?? row.type,
        payload: {
          itemType: row.type,
          toolCallId: row.id,
          status,
          title: item.title,
          data: toolData(row.type, item, status === "failed"),
        },
      });
    }
  }
  return { activities, messages };
}
