// The content hash of a thread record, as the backend stores it and the client compares it, so a
// thread is sent only when its history changed.
import * as NodeCrypto from "node:crypto";

import * as Schema from "effect/Schema";

import { ThreadRecordV1, type ThreadRecord } from "../core/historyRecord.ts";

const encodeThreadJson = Schema.encodeSync(Schema.fromJsonString(ThreadRecordV1));

export const sha256 = (s: string) => NodeCrypto.createHash("sha256").update(s).digest("hex");

/**
 * JSON as jsonb takes it. jsonb refuses `\u0000` (binary output, some tool results) and lone
 * UTF-16 surrogates (text cut mid-emoji, as output clipping can); `JSON.stringify` writes both as
 * escapes and a valid pair as plain characters, so each such escape becomes U+FFFD. One after an
 * escaped backslash (an even run of them) is literal text, kept.
 */
export const forJsonb = (json: string) =>
  json.replace(/(?<!\\)((?:\\\\)*)\\u(?:0000|d[89a-f][0-9a-f]{2})/g, "$1\\ufffd");

/** The thread's content: not when or by which version it was read. */
export const threadSha = (record: ThreadRecord) =>
  sha256(forJsonb(encodeThreadJson({ ...record, takenAt: "", toolreaderVersion: "" })));
