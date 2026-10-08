// Claude Code sessions read straight from their transcripts (`~/.claude/projects/<dir>/<session>.jsonl`),
// for sessions T3 doesn't run. Tool calls become the rows T3 V1 stored for Claude
// (`data: { toolName, input, result }`), so `normalize` reads them like any T3 thread.
// Lines decode loosely: a line that doesn't parse is skipped, not the session.
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import type { ActivityRow, MessageRow } from "./normalize.ts";

const opt = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema));

const Block = Schema.Struct({
  type: opt(Schema.String),
  text: opt(Schema.String),
  thinking: opt(Schema.String),
  /** tool_use */
  id: opt(Schema.String),
  name: opt(Schema.String),
  input: opt(Schema.Record(Schema.String, Schema.Unknown)),
  /** tool_result */
  tool_use_id: opt(Schema.String),
  content: opt(Schema.Unknown),
  is_error: opt(Schema.Boolean),
});
type Block = typeof Block.Type;

const Line = Schema.Struct({
  type: opt(Schema.String),
  subtype: opt(Schema.String),
  uuid: opt(Schema.String),
  timestamp: opt(Schema.String),
  sessionId: opt(Schema.String),
  cwd: opt(Schema.String),
  isMeta: opt(Schema.Boolean),
  isSidechain: opt(Schema.Boolean),
  isCompactSummary: opt(Schema.Boolean),
  aiTitle: opt(Schema.String),
  customTitle: opt(Schema.String),
  message: opt(
    Schema.Struct({
      content: opt(Schema.Union([Schema.String, Schema.Array(Block)])),
    }),
  ),
  /** system api_error */
  error: opt(Schema.Struct({ message: opt(Schema.String) })),
});
type Line = typeof Line.Type;
const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Line));

const ITEM_TYPES: Record<string, string> = {
  Bash: "command_execution",
  Edit: "file_change",
  MultiEdit: "file_change",
  Write: "file_change",
  NotebookEdit: "file_change",
};

const blocks = (l: Line): ReadonlyArray<Block> => {
  const c = l.message?.content;
  return Predicate.isString(c) ? [{ type: "text", text: c }] : (c ?? []);
};

/** Text Claude Code writes as the user: slash-command echoes, `!` shell runs, reminders, task notices. */
const SYNTHETIC =
  /^\s*<(?:command-(?:name|message|args)|local-command-(?:stdout|stderr|caveat)|bash-(?:input|stdout|stderr)|system-reminder|task-notification)>/;

/** What the user typed. */
const typed = (l: Line): string =>
  l.isMeta || l.isCompactSummary
    ? ""
    : blocks(l)
        .flatMap((b) => (b.type === "text" && b.text && !SYNTHETIC.test(b.text) ? [b.text] : []))
        .join("\n");

const parse = (lines: ReadonlyArray<string>): Line[] =>
  lines.flatMap((l) => (l.trim() ? Option.toArray(decodeLine(l)) : []));

export type ClaudeTranscriptMeta = {
  readonly id: string;
  readonly cwd: string | null;
  readonly title: string;
  readonly createdAt: string | null;
};

/** Session id, directory and title from the lines given (the listing reads only a file's first lines). */
export function claudeTranscriptMeta(lines: ReadonlyArray<string>): ClaudeTranscriptMeta | null {
  const parsed = parse(lines);
  const id = parsed.find((l) => l.sessionId)?.sessionId;
  if (!id) return null;
  const last = (f: (l: Line) => string | null | undefined) =>
    parsed.map(f).findLast((t) => !!t?.trim()) ?? undefined;
  const prompt = parsed.find((l) => l.type === "user" && typed(l).trim());
  const title =
    last((l) => l.customTitle) ??
    last((l) => l.aiTitle) ??
    (prompt ? typed(prompt).trim().split("\n")[0]!.slice(0, 160) : "(untitled)");
  return {
    id,
    cwd: parsed.find((l) => l.cwd)?.cwd ?? null,
    title,
    createdAt: parsed.find((l) => l.timestamp)?.timestamp ?? null,
  };
}

/** Turns a transcript's lines into activity and message rows, in file order. */
export function claudeTranscriptToRows(lines: ReadonlyArray<string>): {
  activities: ActivityRow[];
  messages: MessageRow[];
} {
  const activities: ActivityRow[] = [];
  const messages: MessageRow[] = [];
  const calls = new Map<string, { at: string; seq: number; name: string; input: Block["input"] }>();
  const results = new Map<string, Block>();
  const seen = new Set<string>();
  parse(lines).forEach((l, seq) => {
    // Subagents write their own files; a stray sidechain line isn't this session's work.
    if (l.isSidechain) return;
    // Compaction can re-append earlier records; the first copy keeps its place.
    if (l.uuid) {
      if (seen.has(l.uuid)) return;
      seen.add(l.uuid);
    }
    const at = l.timestamp ?? "";
    const id = l.uuid ?? `line-${seq}`;
    if (l.type === "user") {
      for (const b of blocks(l))
        if (b.type === "tool_result" && b.tool_use_id) results.set(b.tool_use_id, b);
      const text = typed(l);
      if (text.trim()) messages.push({ id, at, seq, role: "user", text });
    } else if (l.type === "assistant") {
      blocks(l).forEach((b, i) => {
        if (b.type === "tool_use" && b.id && b.name)
          calls.set(b.id, { at, seq, name: b.name, input: b.input });
        else if (b.type === "text" && b.text?.trim())
          messages.push({ id: `${id}:${i}`, at, seq, role: "assistant", text: b.text });
        else if (b.type === "thinking" && b.thinking?.trim())
          messages.push({ id: `${id}:${i}`, at, seq, role: "reasoning", text: b.thinking });
      });
    } else if (l.type === "system" && l.subtype === "api_error") {
      activities.push({
        id,
        at,
        seq,
        kind: "runtime.error",
        tone: "error",
        summary: "API error",
        payload: { detail: l.error?.message },
      });
    } else if (l.type === "system" && l.subtype === "compact_boundary") {
      activities.push({
        id,
        at,
        seq,
        kind: "context-compaction",
        tone: "info",
        summary: "Context compacted",
        payload: {},
      });
    }
  });
  // A call keeps its own time and place; its result can land many lines later.
  for (const [callId, call] of calls) {
    const r = results.get(callId);
    activities.push({
      id: callId,
      at: call.at,
      seq: call.seq,
      kind: "tool.completed",
      tone: "tool",
      summary: call.name,
      payload: {
        itemType: ITEM_TYPES[call.name] ?? "dynamic_tool",
        toolCallId: callId,
        status: !r ? "inProgress" : r.is_error ? "failed" : "completed",
        data: {
          toolName: call.name,
          input: call.input ?? {},
          result: r ? { content: r.content, is_error: r.is_error ?? false } : undefined,
        },
      },
    });
  }
  return { activities, messages };
}
