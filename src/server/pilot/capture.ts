// Local capture never uploads or decides a permission request. Sync selects these artifacts later.
import * as NodeCrypto from "node:crypto";
// Immutable files avoid sharing an append cursor between concurrent hook processes.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { ARCHIVE, SessionId } from "../../core/codexArchive.ts";

const Json = Schema.Record(Schema.String, Schema.Unknown);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Json));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeId = Schema.decodeUnknownSync(SessionId);
const Hook = Schema.Struct({ session_id: SessionId, hook_event_name: Schema.String });
const decodeHook = Schema.decodeUnknownSync(Hook);
export const CAPTURE_DIR = "toolreader-events";

async function saveEvent(home: string, session: string, type: string, payload: unknown) {
  const id = decodeId(session);
  const timestamp = DateTime.formatIso(DateTime.nowUnsafe());
  const text = `${encodeJson({ type: "session_meta", timestamp, payload: { id, source: "toolreader-hook" } })}\n${encodeJson({ type, timestamp, payload })}\n`;
  if (Buffer.byteLength(text) > ARCHIVE.lineBytes)
    throw new Error("Captured event exceeds 32 MiB; nothing truncated");
  const dir = NodePath.join(home, CAPTURE_DIR, id, "hook");
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
  return saveEvent(home, hook.session_id, `hook.${hook.hook_event_name}`, raw);
}

export async function capturedArtifacts(home: string, session: string) {
  const id = decodeId(session);
  const files: Array<{ file: string; source: "hook" }> = [];
  const dir = NodePath.join(home, CAPTURE_DIR, id, "hook");
  let entries;
  try {
    entries = await NodeFSP.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return files;
    throw e;
  }
  for (const entry of entries)
    if (entry.isFile() && entry.name.endsWith(".jsonl"))
      files.push({ file: NodePath.join(dir, entry.name), source: "hook" });
  return files.sort((a, b) => a.file.localeCompare(b.file));
}
