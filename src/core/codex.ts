// Codex sessions read through `codex app-server` (thread/list, thread/read). Responses are decoded with
// loose schemas on purpose: Codex adds item types and fields often, and one unknown field must not hide a thread.
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import type { ActivityRow, MessageRow } from "./normalize.ts";
import { CodexItem } from "./payload.ts";

const opt = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema));

export const CodexThreadMeta = Schema.Struct({
  id: Schema.String,
  name: opt(Schema.String),
  preview: opt(Schema.String),
  cwd: opt(Schema.String),
  path: opt(Schema.String),
  /** Unix seconds. */
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  originator: opt(Schema.String),
  source: opt(Schema.Unknown),
  parentThreadId: opt(Schema.String),
  ephemeral: opt(Schema.Boolean),
  gitInfo: opt(Schema.Struct({ branch: opt(Schema.String) })),
});
export type CodexThreadMeta = typeof CodexThreadMeta.Type;

export const CodexThreadListPage = Schema.Struct({
  data: Schema.Array(CodexThreadMeta),
  nextCursor: opt(Schema.String),
});

export const CodexTurn = Schema.Struct({
  id: Schema.String,
  startedAt: opt(Schema.Number),
  items: Schema.Array(Schema.Unknown),
});

export const CodexThreadRead = Schema.Struct({
  thread: Schema.Struct({ ...CodexThreadMeta.fields, turns: opt(Schema.Array(CodexTurn)) }),
});
export type CodexThreadRead = typeof CodexThreadRead.Type;

const ItemEnvelope = Schema.Struct({
  type: Schema.String,
  id: Schema.String,
  status: opt(Schema.String),
});
const UserMessage = Schema.Struct({
  content: opt(Schema.Array(Schema.Struct({ text: opt(Schema.String) }))),
});
const AgentMessage = Schema.Struct({ text: opt(Schema.String) });
const Reasoning = Schema.Struct({
  summary: opt(Schema.Array(Schema.String)),
  content: opt(Schema.Array(Schema.String)),
});
const decodeEnvelope = Schema.decodeUnknownOption(ItemEnvelope);
const decodeUserMessage = Schema.decodeUnknownOption(UserMessage);
const decodeAgentMessage = Schema.decodeUnknownOption(AgentMessage);
const decodeReasoning = Schema.decodeUnknownOption(Reasoning);
const decodeItem = Schema.decodeUnknownOption(CodexItem);

// --- Copied from t3code apps/server/src/provider/Layers/CodexAdapter.ts (normalizeItemType, toCanonicalItemType). ---
function normalizeItemType(raw: string): string {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function toCanonicalItemType(raw: string): string {
  const type = normalizeItemType(raw);
  if (type.includes("user")) return "user_message";
  if (type.includes("agent message") || type.includes("assistant")) return "assistant_message";
  if (type.includes("reasoning") || type.includes("thought")) return "reasoning";
  if (type.includes("plan") || type.includes("todo")) return "plan";
  if (type.includes("command")) return "command_execution";
  if (type.includes("file change") || type.includes("patch") || type.includes("edit"))
    return "file_change";
  if (type.includes("mcp")) return "mcp_tool_call";
  if (type.includes("dynamic tool")) return "dynamic_tool_call";
  if (type.includes("collab")) return "collab_agent_tool_call";
  if (type.includes("web search")) return "web_search";
  if (type.includes("image")) return "image_view";
  if (type.includes("review entered")) return "review_entered";
  if (type.includes("review exited")) return "review_exited";
  if (type.includes("compact")) return "context_compaction";
  if (type.includes("error")) return "error";
  return "unknown";
}
// --- End of copied code. ---

/** Item types that are bookkeeping, not actions. */
const SKIPPED = new Set(["plan", "review_entered", "review_exited", "unknown"]);

/**
 * Item id → ISO timestamp of the first rollout line that mentions it. thread/read items carry no
 * times, but every rollout line does; ids match across Codex versions (checked from 0.42 to 0.159).
 */
export function scanItemTimes(
  lines: Iterable<string>,
  into = new Map<string, string>(),
): Map<string, string> {
  for (const line of lines) {
    if (!line.startsWith('{"timestamp":"')) continue;
    const at = line.slice(14, line.indexOf('"', 14));
    for (const m of line.matchAll(/"(?:id|call_id|item_id)":"([^"]+)"/g))
      if (!into.has(m[1]!)) into.set(m[1]!, at);
  }
  return into;
}

export const isoFromSeconds = (s: number) => DateTime.formatIso(DateTime.makeUnsafe(s * 1000));

/** Converts a thread/read result into the T3-shaped rows `normalize` already understands. */
export function codexThreadToRows(
  read: CodexThreadRead,
  times: ReadonlyMap<string, string>,
): { activities: ActivityRow[]; messages: MessageRow[] } {
  const activities: ActivityRow[] = [];
  const messages: MessageRow[] = [];
  let lastAt = isoFromSeconds(read.thread.createdAt);
  for (const turn of read.thread.turns ?? []) {
    if (turn.startedAt) lastAt = isoFromSeconds(turn.startedAt);
    for (const raw of turn.items) {
      const envelope = decodeEnvelope(raw);
      if (Option.isNone(envelope)) continue;
      const { id, type, status } = envelope.value;
      // Items missing from the rollout scan inherit the previous item's time, keeping order stable.
      const at = times.get(id) ?? lastAt;
      lastAt = at;
      const kind = toCanonicalItemType(type);
      if (kind === "user_message") {
        const text = Option.match(decodeUserMessage(raw), {
          onNone: () => "",
          onSome: (m) => (m.content ?? []).map((c) => c.text ?? "").join("\n"),
        });
        messages.push({ id, at, role: "user", text });
      } else if (kind === "assistant_message") {
        messages.push({
          id,
          at,
          role: "assistant",
          text: Option.getOrUndefined(decodeAgentMessage(raw))?.text ?? "",
        });
      } else if (kind === "reasoning") {
        const r = Option.getOrUndefined(decodeReasoning(raw));
        messages.push({
          id,
          at,
          role: "reasoning",
          text: [...(r?.summary ?? []), ...(r?.content ?? [])].join("\n\n"),
        });
      } else if (kind === "context_compaction") {
        activities.push({
          id,
          at,
          kind: "context-compaction",
          tone: "info",
          summary: "Context compacted",
          payload: {},
        });
      } else if (!SKIPPED.has(kind)) {
        const item = Option.getOrElse(decodeItem(raw), () => ({}));
        activities.push({
          id,
          at,
          kind: "tool.completed",
          tone: "tool",
          summary: type,
          payload: {
            itemType: kind,
            toolCallId: id,
            status: Predicate.isString(status) ? status : "completed",
            title: type,
            data: { item },
          },
        });
      }
    }
  }
  return { activities, messages };
}

/** Codex session origins that are scripted rather than interactive. */
export const isScriptedOrigin = (originator: string | null | undefined) =>
  originator === "codex_exec";
