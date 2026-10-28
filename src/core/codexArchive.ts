// A lossless event envelope for the private Codex pilot. Unknown event types stay queryable.
import * as Schema from "effect/Schema";

export const ARCHIVE = {
  chunkBytes: 4 * 1024 * 1024,
  maxBytes: 1024 * 1024 * 1024,
  lineBytes: 32 * 1024 * 1024,
} as const;
export const SessionId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
);
const Hash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const ArchiveStart = Schema.Struct({
  sessionId: SessionId,
  rootId: SessionId,
  sha256: Hash,
  bytes: Count.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(ARCHIVE.maxBytes)),
  parts: Count.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(256)),
});
export type ArchiveStart = typeof ArchiveStart.Type;
export const ArchivePart = Schema.Struct({
  uploadId: SessionId,
  part: Count.check(Schema.isLessThan(256)),
  data: Schema.String.check(
    Schema.isMaxLength(4 * Math.ceil(ARCHIVE.chunkBytes / 3)),
    Schema.isPattern(/^[A-Za-z0-9+/]*={0,2}$/),
  ),
});
export const ArchiveFinish = Schema.Struct({ uploadId: SessionId });
export const ArchiveLink = Schema.Struct({
  repo: Schema.String.check(Schema.isPattern(/^[^\s/]+\/[^\s/]+$/)),
  sha: Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)),
  sessionId: SessionId,
  role: Schema.Literals(["implemented", "tested", "reviewed", "deployed"]),
});
export type ArchiveLink = typeof ArchiveLink.Type;

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const decodeObject = Schema.decodeUnknownSync(Schema.fromJsonString(JsonObject));
const Event = Schema.Struct({
  type: Schema.String,
  timestamp: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
});
const decodeEvent = Schema.decodeUnknownSync(Event);
const Metadata = Schema.Struct({
  type: Schema.Literal("session_meta"),
  payload: Schema.Struct({ id: SessionId }),
});
const decodeMetadata = Schema.decodeUnknownSync(Metadata);

export function archiveEvent(line: string, seq: number) {
  const raw = decodeObject(line);
  const event = decodeEvent(raw);
  return { seq, type: event.type, at: event.timestamp ?? null, raw };
}
export function archiveSession(line: string) {
  return decodeMetadata(decodeObject(line)).payload.id;
}

const Call = Schema.Struct({
  type: Schema.Literal("function_call"),
  name: Schema.String,
  arguments: Schema.String,
});
const decodeCall = Schema.decodeUnknownOption(Call);
const PeerArgs = Schema.Struct({
  threadId: Schema.optional(Schema.String),
  thread_id: Schema.optional(Schema.String),
  target: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
});
const decodePeer = Schema.decodeUnknownOption(Schema.fromJsonString(PeerArgs));
const Message = Schema.Struct({
  type: Schema.Literal("inter_agent_message"),
  from: Schema.optional(Schema.String),
  sender_thread_id: Schema.optional(Schema.String),
});
const decodeMessage = Schema.decodeUnknownOption(Message);
const decodeId = Schema.decodeUnknownOption(SessionId);
const MESSAGE_TOOLS = /(?:^|__)(?:send_message_to_thread|send_message|send_input|followup_task)$/;

/** Only explicit message edges in the selected root. Never infer relations from mentioned UUIDs. */
export function archivePeers(raw: Record<string, unknown>): string[] {
  const call = decodeCall(raw.payload);
  const message = decodeMessage(raw.type === "inter_agent_message" ? raw : raw.payload);
  let candidates: Array<string | undefined> = [];
  if (call._tag === "Some" && MESSAGE_TOOLS.test(call.value.name)) {
    const args = decodePeer(call.value.arguments);
    if (args._tag === "Some")
      candidates = [args.value.threadId, args.value.thread_id, args.value.target, args.value.id];
  }
  if (message._tag === "Some") candidates.push(message.value.from, message.value.sender_thread_id);
  return candidates.flatMap((s) => {
    const id = decodeId(s);
    return id._tag === "Some" ? [id.value] : [];
  });
}

const Hook = Schema.Struct({
  hook_event_name: Schema.String,
  tool_name: Schema.optional(Schema.String),
  tool_input: Schema.optional(Schema.Unknown),
});
const HookCommand = Schema.Struct({
  command: Schema.optional(Schema.String),
  cmd: Schema.optional(Schema.String),
});
const decodeHookCommand = Schema.decodeUnknownOption(HookCommand);
const decodeHook = Schema.decodeUnknownSync(Schema.fromJsonString(Hook));
export function archiveReminder(input: string) {
  const event = decodeHook(input);
  const start = event.hook_event_name === "SessionStart";
  const args = decodeHookCommand(event.tool_input);
  const command = args._tag === "Some" ? (args.value.command ?? args.value.cmd ?? "") : "";
  const trigger =
    /\bgit\b[\s\S]*\bcommit\b|\bgh\s+pr\s+(?:create|edit)\b/.test(command) ||
    /(?:create|update)_pull_request/.test(event.tool_name ?? "");
  if (!start && !trigger) return null;
  return {
    hookSpecificOutput: {
      hookEventName: start ? "SessionStart" : "PostToolUse",
      additionalContext:
        "Use the codex-history skill after each commit, when preparing or updating a PR, and when asked to sync. Link only this session's relevant commits. Sync this chat and direct message peers only. Include peers you actually messaged or received messages from, using known UUIDs with --related when automatic detection cannot identify them. Do not search unrelated session contents. Upload failures must be reported as failures. PR preparation triggers sync, never a PR link. The helper is toolreader pilot sync.",
    },
  };
}
