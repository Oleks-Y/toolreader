// Codex rollout files read without `codex app-server`: rebuilds the thread/read result the app-server
// would return (its turns are the persisted `item_completed` events; a repeated item id keeps its last
// version at its first place), so codex.ts and normalize.ts treat both paths alike. Pure; the server
// reads the files (CodexRollouts.ts).
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import type { CodexThreadRead } from "./codex.ts";
import { scanRollout, shellJoin, type RolloutScan } from "./rollout.ts";

const opt = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema));

const Line = Schema.Struct({
  timestamp: Schema.String,
  ordinal: opt(Schema.Number),
  type: Schema.String,
  payload: Schema.Unknown,
});
const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Line));
const SessionMeta = Schema.Struct({
  id: Schema.String,
  timestamp: opt(Schema.String),
  cwd: opt(Schema.String),
  originator: opt(Schema.String),
  source: opt(Schema.Unknown),
  git: opt(Schema.Struct({ branch: opt(Schema.String) })),
  /** Delegated threads start with a copy of their parent's history; thread/read hides it. */
  subagent_history_start_ordinal: opt(Schema.Number),
});
const decodeSessionMeta = Schema.decodeUnknownOption(SessionMeta);
const Event = Schema.Struct({
  type: Schema.String,
  turn_id: opt(Schema.String),
  started_at: opt(Schema.Number),
  item: opt(Schema.Record(Schema.String, Schema.Unknown)),
});
const decodeEvent = Schema.decodeUnknownOption(Event);

// Rollout items are the core's serde shapes (PascalCase types, snake_case fields); thread/read
// speaks the app-server's camelCase. Only fields that change shape are decoded; the rest pass through.
const Envelope = Schema.Struct({
  type: Schema.String,
  id: Schema.String,
  kind: opt(Schema.String),
});
const decodeEnvelope = Schema.decodeUnknownOption(Envelope);
const Command = Schema.Struct({
  command: opt(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  parsed_cmd: opt(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
});
const decodeCommand = Schema.decodeUnknownOption(Command);
const Changes = Schema.Struct({
  changes: opt(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        type: Schema.String,
        unified_diff: opt(Schema.String),
        content: opt(Schema.String),
        move_path: opt(Schema.String),
      }),
    ),
  ),
});
const decodeChanges = Schema.decodeUnknownOption(Changes);
const Texts = Schema.Struct({
  content: opt(Schema.Array(Schema.Struct({ text: opt(Schema.String) }))),
  summary_text: opt(Schema.Array(Schema.String)),
  raw_content: opt(Schema.Array(Schema.String)),
});
const decodeTexts = Schema.decodeUnknownOption(Texts);
const WebAction = Schema.Struct({ action: opt(Schema.Record(Schema.String, Schema.Unknown)) });
const decodeWebAction = Schema.decodeUnknownOption(WebAction);
const McpResult = Schema.Struct({
  result: opt(
    Schema.Struct({
      content: Schema.Unknown,
      structuredContent: opt(Schema.Unknown),
      _meta: opt(Schema.Unknown),
    }),
  ),
});
const decodeMcpResult = Schema.decodeUnknownOption(McpResult);

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const camelKeys = (o: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [camel(k), v]));
const camelValue = (v: unknown) => (Predicate.isString(v) ? camel(v) : v);
const fileUrl = (v: unknown) => (Predicate.isString(v) ? v.replace(/^file:\/\//, "") : v);

/** `Extension` items carry their app-server type in `kind`. */
const EXTENSIONS: Record<string, string> = {
  "web.search": "webSearch",
  "clock.sleep": "sleep",
  "image_gen.generation": "imageGeneration",
};

/** A rollout `item_completed` item as the app-server item thread/read returns. */
export function readItem(raw: Readonly<Record<string, unknown>>): Record<string, unknown> | null {
  const envelope = Option.getOrUndefined(decodeEnvelope(raw));
  if (!envelope) return null;
  const { type: _type, kind: _kind, ...fields } = camelKeys(raw);
  const type =
    envelope.type === "Extension"
      ? (EXTENSIONS[envelope.kind ?? ""] ?? "extension")
      : envelope.type.charAt(0).toLowerCase() + envelope.type.slice(1);
  const item: Record<string, unknown> = { ...fields, type, status: camelValue(fields["status"]) };
  if (item["status"] === undefined) delete item["status"];

  switch (type) {
    case "agentMessage": {
      const t = Option.getOrUndefined(decodeTexts(raw));
      item["text"] = (t?.content ?? []).map((c) => c.text ?? "").join("");
      delete item["content"];
      break;
    }
    case "reasoning": {
      const t = Option.getOrUndefined(decodeTexts(raw));
      item["summary"] = t?.summary_text ?? [];
      item["content"] = t?.raw_content ?? [];
      delete item["summaryText"];
      delete item["rawContent"];
      break;
    }
    case "commandExecution": {
      const c = Option.getOrUndefined(decodeCommand(raw));
      item["command"] = Array.isArray(c?.command) ? shellJoin(c.command) : (c?.command ?? "");
      item["cwd"] = fileUrl(item["cwd"]);
      if (item["source"] !== undefined) item["source"] = camelValue(item["source"]);
      item["commandActions"] = (c?.parsed_cmd ?? []).map(({ type, cmd, ...rest }) => ({
        type: camelValue(type),
        command: cmd,
        ...rest,
      }));
      delete item["parsedCmd"];
      break;
    }
    case "fileChange": {
      const changes = Option.getOrUndefined(decodeChanges(raw))?.changes ?? {};
      item["changes"] = Object.keys(changes)
        .sort()
        .map((path) => {
          const c = changes[path]!;
          const moved = c.move_path ? `\n\nMoved to: ${c.move_path}` : "";
          return {
            path,
            kind: {
              type: c.type,
              ...(c.move_path !== undefined ? { move_path: c.move_path } : {}),
            },
            diff: (c.type === "update" ? (c.unified_diff ?? "") : (c.content ?? "")) + moved,
          };
        });
      break;
    }
    case "webSearch": {
      const action = Option.getOrUndefined(decodeWebAction(raw))?.action;
      if (action) item["action"] = { ...action, type: camelValue(action["type"]) };
      break;
    }
    case "imageView":
      item["path"] = fileUrl(item["path"]);
      break;
    case "mcpToolCall": {
      const r = Option.getOrUndefined(decodeMcpResult(raw))?.result;
      if (r)
        item["result"] = {
          content: r.content,
          structuredContent: r.structuredContent ?? null,
          _meta: r._meta ?? null,
        };
      break;
    }
  }
  return item;
}

const seconds = (iso: string | null | undefined) =>
  Option.match(Option.flatMap(Option.fromNullishOr(iso), DateTime.make), {
    onNone: () => 0,
    onSome: (d) => Math.floor(DateTime.toEpochMillis(d) / 1000),
  });

const isSubagent = (source: unknown) => Predicate.isObject(source) && "subagent" in source;

/** A rollout's `session_meta` line (its first): enough to list the session without reading the rest. */
export function rolloutMeta(firstLine: string) {
  const line = Option.getOrUndefined(decodeLine(firstLine));
  const meta = line?.type === "session_meta" ? decodeSessionMeta(line.payload) : Option.none();
  return Option.getOrNull(
    Option.map(meta, (m) => ({
      id: m.id,
      cwd: m.cwd ?? null,
      originator: m.originator ?? null,
      createdAt: seconds(m.timestamp ?? line?.timestamp),
      subagent: isSubagent(m.source),
    })),
  );
}

export type RolloutSession = {
  readonly read: CodexThreadRead;
  readonly scan: RolloutScan;
  /** Spawned by another session (subagents, guardian reviews): reached through its parent. */
  readonly subagent: boolean;
};

/**
 * A whole rollout file as thread/read would return it, plus its scan (item times, and the tool calls
 * only response items kept; see rollout.ts). `null` when it has no `session_meta` line. Lines that
 * fail to decode are skipped, never the session.
 */
export function readRollout(lines: ReadonlyArray<string>, path: string): RolloutSession | null {
  let meta: typeof SessionMeta.Type | undefined;
  let lastAt: string | undefined;
  let turnId: string | undefined;
  let preview: string | undefined;
  const turns = new Map<
    string,
    { id: string; startedAt: number | null; status: string; items: Map<string, unknown> }
  >();
  const turnFor = (id: string) => {
    let turn = turns.get(id);
    if (!turn)
      turns.set(id, (turn = { id, startedAt: null, status: "inProgress", items: new Map() }));
    return turn;
  };

  for (const text of lines) {
    const line = Option.getOrUndefined(decodeLine(text));
    if (!line) continue;
    lastAt = line.timestamp;
    if (line.type === "session_meta") {
      meta ??= Option.getOrUndefined(decodeSessionMeta(line.payload));
      continue;
    }
    if (line.type !== "event_msg") continue;
    if ((line.ordinal ?? Infinity) < (meta?.subagent_history_start_ordinal ?? 0)) continue;
    const event = Option.getOrUndefined(decodeEvent(line.payload));
    if (!event) continue;
    switch (event.type) {
      case "task_started":
        turnId = event.turn_id ?? turnId;
        if (turnId) turnFor(turnId).startedAt = event.started_at ?? seconds(line.timestamp);
        break;
      case "task_complete":
      case "turn_aborted": {
        const id = event.turn_id ?? turnId;
        if (id) turnFor(id).status = event.type === "task_complete" ? "completed" : "interrupted";
        break;
      }
      case "item_completed": {
        const id = event.turn_id ?? turnId;
        const item = event.item ? readItem(event.item) : null;
        if (!id || !item) break;
        const items = turnFor(id).items;
        // Streamed items (reasoning summaries) complete again under the same id: last wins, first place.
        items.set(String(item["id"]), item);
        if (preview === undefined && item["type"] === "userMessage") {
          const t = Option.getOrUndefined(decodeTexts(event.item));
          preview = (t?.content ?? []).map((c) => c.text ?? "").join("\n");
        }
        break;
      }
    }
  }
  if (!meta) return null;

  const createdAt = seconds(meta.timestamp ?? lastAt);
  return {
    read: {
      thread: {
        id: meta.id,
        preview: preview ?? null,
        cwd: meta.cwd ?? null,
        path,
        createdAt,
        updatedAt: Math.max(createdAt, seconds(lastAt)),
        originator: meta.originator ?? null,
        source: meta.source ?? null,
        gitInfo: meta.git ? { branch: meta.git.branch ?? null } : null,
        turns: [...turns.values()].map((t) => ({
          id: t.id,
          startedAt: t.startedAt,
          status: t.status,
          items: [...t.items.values()],
        })),
      },
    },
    scan: scanRollout(lines),
    subagent: isSubagent(meta.source),
  };
}
