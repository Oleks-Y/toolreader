// Codex sessions read through `codex app-server` (thread/list, thread/read). Responses are decoded with
// loose schemas on purpose: Codex adds item types and fields often, and one unknown field must not hide a thread.
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ActivityRow, MessageRow } from "./normalize.ts";
import { CodexItem } from "./payload.ts";
import { emptyScan, rolloutItem, type RolloutScan } from "./rollout.ts";

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
  /** completed | interrupted | failed | inProgress */
  status: opt(Schema.String),
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

export const isoFromSeconds = (s: number) => DateTime.formatIso(DateTime.makeUnsafe(s * 1000));

/** What a web action did: its type, and its query or its URL (and pattern). */
function webKey(item: CodexItem): string {
  const a = item.action;
  const type = (a?.type ?? "search").replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  const query = item.query || a?.query || a?.queries?.[0] || "";
  return type === "search" ? `search ${query}` : `${type} ${a?.url ?? ""} ${a?.pattern ?? ""}`;
}

/**
 * Converts a thread/read result into the T3-shaped rows `normalize` already understands, adding the
 * tool calls only the rollout file kept (see rollout.ts).
 */
export function codexThreadToRows(
  read: CodexThreadRead,
  scan: RolloutScan = emptyScan(),
): { activities: ActivityRow[]; messages: MessageRow[] } {
  const activities: ActivityRow[] = [];
  const messages: MessageRow[] = [];
  const toolRow = (id: string, at: string, seq: number, type: string, raw: unknown) => {
    const item = Option.getOrElse(decodeItem(raw), (): CodexItem => ({}));
    activities.push({
      id,
      at,
      seq,
      kind: "tool.completed",
      tone: "tool",
      summary: type,
      payload: {
        itemType: toCanonicalItemType(type),
        toolCallId: id,
        status: item.status ?? "completed",
        title: type,
        data: { item },
      },
    });
    return item;
  };

  // Thread/read items that became actions, and the web actions among them that no rollout call id
  // names: each can stand for one rollout web_search_call (see below).
  const shown = new Set<string>();
  const webItems: Array<{ key: string; line: number | undefined; used: boolean }> = [];
  const turnIds = new Set<string>();
  const finishedTurns = new Set<string>();
  let lastAt = isoFromSeconds(read.thread.createdAt);
  // Rollout line order breaks timestamp ties, for thread/read items and rollout calls alike. Items
  // with no line of their own sort just after the previous one, in thread/read order.
  let lastLine = -1;
  let unplaced = 0;
  for (const turn of read.thread.turns ?? []) {
    turnIds.add(turn.id);
    if (turn.status && turn.status !== "inProgress") finishedTurns.add(turn.id);
    if (turn.startedAt) lastAt = isoFromSeconds(turn.startedAt);
    for (const raw of turn.items) {
      const envelope = decodeEnvelope(raw);
      if (Option.isNone(envelope)) continue;
      const { id, type } = envelope.value;
      // Items missing from the rollout scan inherit the previous item's place, keeping order stable.
      const at = scan.times.get(id) ?? lastAt;
      const line = scan.lines.get(id);
      unplaced = line === undefined ? unplaced + 1 : 0;
      lastLine = line ?? lastLine;
      const seq = lastLine + unplaced / 1e6;
      lastAt = at;
      const kind = toCanonicalItemType(type);
      if (kind === "user_message") {
        const text = Option.match(decodeUserMessage(raw), {
          onNone: () => "",
          onSome: (m) => (m.content ?? []).map((c) => c.text ?? "").join("\n"),
        });
        messages.push({ id, at, seq, role: "user", text });
      } else if (kind === "assistant_message") {
        messages.push({
          id,
          at,
          seq,
          role: "assistant",
          text: Option.getOrUndefined(decodeAgentMessage(raw))?.text ?? "",
        });
      } else if (kind === "reasoning") {
        const r = Option.getOrUndefined(decodeReasoning(raw));
        messages.push({
          id,
          at,
          seq,
          role: "reasoning",
          text: [...(r?.summary ?? []), ...(r?.content ?? [])].join("\n\n"),
        });
      } else if (kind === "context_compaction") {
        activities.push({
          id,
          at,
          seq,
          kind: "context-compaction",
          tone: "info",
          summary: "Context compacted",
          payload: {},
        });
      } else if (!SKIPPED.has(kind)) {
        const item = toolRow(id, at, seq, type, raw);
        shown.add(id);
        if (item.type === "webSearch" && !scan.byId.has(id))
          webItems.push({ key: webKey(item), line: scan.lines.get(id), used: false });
      }
    }
  }

  // Items with no call of their own: what code-mode scripts ran (`exec-…` ids).
  const nestedLines = [...shown].flatMap((id) =>
    scan.byId.has(id) ? [] : Option.toArray(Option.fromNullishOr(scan.lines.get(id))),
  );
  // Rolled-back turns stay in the rollout; only trust turn ids when both sides use the same ones.
  const sameTurnIds = [...turnIds].some((t) => scan.turns.has(t));
  // Web calls in rollout order: an item belongs to the call it sits next to.
  const webCalls = scan.calls.filter((c) => c.name === "web_search").map((c) => c.line);
  for (const call of scan.calls) {
    if (shown.has(call.id)) continue;
    if (sameTurnIds && call.turnId && !turnIds.has(call.turnId)) continue;
    if (call.name === "exec" && nestedLines.some((l) => l > call.line && l <= call.lastLine))
      continue;
    // A call with no output in a finished turn was cut off (e.g. Codex was killed mid-command).
    const ended = call.turnId
      ? finishedTurns.has(call.turnId)
      : finishedTurns.size === turnIds.size;
    const raw = rolloutItem(call, call.ended || ended);
    if (!raw) continue;
    const type = String(raw["type"]);
    if (type === "webSearch") {
      // web_search_call lines carry no id. Its item is the same action completed next to it (just
      // before or after, by Codex version), between the neighbouring web calls. Each item stands
      // for one call, so repeated searches for one query all stay.
      const key = webKey(Option.getOrElse(decodeItem(raw), (): CodexItem => ({})));
      const j = webCalls.indexOf(call.line);
      const lo = webCalls[j - 1] ?? -Infinity;
      const hi = webCalls[j + 1] ?? Infinity;
      const distance = (w: (typeof webItems)[number]) =>
        w.line === undefined ? Infinity : Math.abs(w.line - call.line);
      const match = webItems
        .filter(
          (w) => !w.used && w.key === key && (w.line === undefined || (w.line > lo && w.line < hi)),
        )
        .sort((a, b) => distance(a) - distance(b))[0];
      if (match) {
        match.used = true;
        continue;
      }
    }
    toolRow(call.id, call.at, call.line, type, raw);
  }
  return { activities, messages };
}

/** Codex session origins that are scripted rather than interactive. */
export const isScriptedOrigin = (originator: string | null | undefined) =>
  originator === "codex_exec";
