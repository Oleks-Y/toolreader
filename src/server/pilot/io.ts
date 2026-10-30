// Streaming bounds memory independently of artifact size.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import { ARCHIVE } from "../../core/codexArchive.ts";

/** Bound one JSONL record, not the session. A partial final record fails JSON validation. */
export async function* archiveLines(file: string) {
  let pending: Buffer[] = [];
  let bytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const append = (part: Buffer) => {
    bytes += part.length;
    if (bytes > ARCHIVE.lineBytes)
      throw new Error("Codex record exceeds 32 MiB; nothing truncated");
    pending.push(part);
  };
  const line = () => {
    const text = decoder.decode(Buffer.concat(pending, bytes));
    pending = [];
    bytes = 0;
    if (!text.trim()) throw new Error("Empty Codex record; nothing discarded");
    return text;
  };
  for await (const data of NodeFS.createReadStream(file)) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let start = 0;
    for (;;) {
      const end = chunk.indexOf(10, start);
      if (end === -1) break;
      append(chunk.subarray(start, end));
      yield line();
      start = end + 1;
    }
    if (start < chunk.length) append(chunk.subarray(start));
  }
  // A valid final JSON record needs no newline. Decoding rejects a partial record.
  if (bytes) yield line();
}
