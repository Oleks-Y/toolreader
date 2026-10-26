// The images in a session's entries, made ready to send: each action's `media` keeps its hash and
// size, and the bytes go apart, one per hash, to the backend's media bucket (HistorySync).
import * as NodeCrypto from "node:crypto";

import type { Entry, Media } from "../../core/domain.ts";
import { LIMITS, MEDIA_TYPES } from "../../core/historyApi.ts";

export type Blob = { readonly sha256: string; readonly mime: string; readonly data: string };

/**
 * Entries with each image as its hash, and the images to send. One the bucket won't keep (a type
 * not in MEDIA_TYPES, or over LIMITS.mediaBytes) is dropped from both.
 */
export function extractMedia(entries: ReadonlyArray<Entry>): {
  readonly entries: Entry[];
  readonly blobs: ReadonlyMap<string, Blob>;
} {
  const blobs = new Map<string, Blob>();
  const out = entries.map((e): Entry => {
    if (e.type !== "action" || !e.media) return e;
    const media = e.media.flatMap((m): Media[] => {
      if (!m.data || !(MEDIA_TYPES as ReadonlyArray<string>).includes(m.mime)) return [];
      const bytes = Buffer.from(m.data, "base64");
      if (bytes.length === 0 || bytes.length > LIMITS.mediaBytes) return [];
      const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
      blobs.set(sha256, { sha256, mime: m.mime, data: m.data });
      return [{ mime: m.mime, sha256, bytes: bytes.length }];
    });
    const { media: _, ...rest } = e;
    return media.length ? { ...rest, media } : rest;
  });
  return { entries: out, blobs };
}
