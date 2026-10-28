// Local capture never uploads or decides a permission request. Sync selects these artifacts later.
import * as NodeCrypto from "node:crypto";
// Immutable files avoid sharing an append cursor between concurrent hook processes.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { ARCHIVE, SessionId, type ArtifactSource } from "../../core/codexArchive.ts";

const Json = Schema.Record(Schema.String, Schema.Unknown);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Json));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeId = Schema.decodeUnknownSync(SessionId);
const Hook = Schema.Struct({ session_id: SessionId, hook_event_name: Schema.String });
const decodeHook = Schema.decodeUnknownSync(Hook);
const Scope = Schema.Struct({
  threadId: Schema.optional(SessionId),
  thread_id: Schema.optional(SessionId),
  thread: Schema.optional(Schema.Struct({ id: SessionId })),
});
const decodeScope = Schema.decodeUnknownOption(Scope);
const Wire = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
});
const decodeWire = Schema.decodeUnknownSync(Wire);
export type CaptureSource = Exclude<ArtifactSource, "rollout">;
export const CAPTURE_DIR = "toolreader-events";

export async function saveEvent(
  home: string,
  session: string,
  source: CaptureSource,
  type: string,
  payload: unknown,
) {
  const id = decodeId(session);
  const timestamp = DateTime.formatIso(DateTime.nowUnsafe());
  const text = `${encodeJson({ type: "session_meta", timestamp, payload: { id, source: `toolreader-${source}` } })}\n${encodeJson({ type, timestamp, payload })}\n`;
  if (Buffer.byteLength(text) > ARCHIVE.lineBytes)
    throw new Error("Captured event exceeds 32 MiB; nothing truncated");
  const dir = NodePath.join(home, CAPTURE_DIR, id, source);
  await NodeFSP.mkdir(dir, { recursive: true, mode: 0o700 });
  const name = `${timestamp.replaceAll(":", "-")}-${NodeCrypto.randomUUID()}`;
  const temp = NodePath.join(dir, `.${name}.tmp`);
  const target = NodePath.join(dir, `${name}.jsonl`);
  const handle = await NodeFSP.open(temp, "wx", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await NodeFSP.rename(temp, target);
  return target;
}

export async function recordHook(home: string, input: string) {
  const raw = decodeJson(input);
  const hook = decodeHook(raw);
  return saveEvent(home, hook.session_id, "hook", `hook.${hook.hook_event_name}`, raw);
}

/** Routes a response back to its request's thread. Auth/account messages have no thread and are not captured. */
export class StreamRoutes {
  private readonly starts = new Map<string | number, Record<string, unknown>>();
  private readonly clientRequests = new Map<string | number, string>();
  private readonly serverRequests = new Map<string | number, string>();
  event(direction: "client" | "server", line: string) {
    const raw = decodeJson(line);
    const wire = decodeWire(raw);
    const scoped = decodeScope(wire.method ? wire.params : wire.result);
    const direct =
      scoped._tag === "Some"
        ? (scoped.value.threadId ?? scoped.value.thread_id ?? scoped.value.thread?.id)
        : undefined;
    if (direction === "client" && wire.method === "thread/start" && wire.id !== undefined)
      this.starts.set(wire.id, raw);
    const requests = direction === "client" ? this.clientRequests : this.serverRequests;
    const replies = direction === "client" ? this.serverRequests : this.clientRequests;
    const session =
      direct ?? (wire.id !== undefined && !wire.method ? replies.get(wire.id) : undefined);
    if (session && wire.id !== undefined) {
      if (wire.method) requests.set(wire.id, session);
      else replies.delete(wire.id);
    }
    if (!session) return [];
    const replay =
      direction === "server" && !wire.method && wire.id !== undefined
        ? this.starts.get(wire.id)
        : undefined;
    if (replay && wire.id !== undefined) this.starts.delete(wire.id);
    return [
      ...(replay
        ? [{ session, type: "thread/start", payload: { direction: "client", message: replay } }]
        : []),
      { session, type: wire.method ?? "response", payload: { direction, message: raw } },
    ];
  }
}

export async function capturedArtifacts(home: string, session: string) {
  const id = decodeId(session);
  const files: Array<{ file: string; source: CaptureSource }> = [];
  for (const source of ["hook", "app-server"] as const) {
    const dir = NodePath.join(home, CAPTURE_DIR, id, source);
    let entries;
    try {
      entries = await NodeFSP.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (e instanceof Error && "code" in e && e.code === "ENOENT") continue;
      throw e;
    }
    for (const entry of entries)
      if (entry.isFile() && entry.name.endsWith(".jsonl"))
        files.push({ file: NodePath.join(dir, entry.name), source });
  }
  return files.sort((a, b) => a.file.localeCompare(b.file));
}

/** One writer owns each stream file; unrelated threads never share a file or append cursor. */
export class StreamCapture {
  private readonly files = new Map<string, string>();
  private pending: Promise<void> = Promise.resolve();
  private readonly home: string;
  constructor(home: string) {
    this.home = home;
  }
  record(event: ReturnType<StreamRoutes["event"]>[number]) {
    this.pending = this.pending.then(async () => {
      const file = this.files.get(event.session);
      if (!file) {
        this.files.set(
          event.session,
          await saveEvent(this.home, event.session, "app-server", event.type, event.payload),
        );
        return;
      }
      const text =
        encodeJson({
          type: event.type,
          timestamp: DateTime.formatIso(DateTime.nowUnsafe()),
          payload: event.payload,
        }) + "\n";
      if (Buffer.byteLength(text) > ARCHIVE.lineBytes)
        throw new Error("App-server record exceeds 32 MiB; nothing truncated");
      const handle = await NodeFSP.open(file, "a");
      try {
        await handle.writeFile(text);
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    return this.pending;
  }
  flush() {
    return this.pending;
  }
}
