import * as NodeCrypto from "node:crypto";

import { assert, describe, it } from "@effect/vitest";

import type { Action } from "../../core/domain.ts";
import { LIMITS } from "../../core/historyApi.ts";
import { admitThread, buildThreadRecord } from "../../core/historyRecord.ts";
import { extractMedia } from "./media.ts";

const action = (media: Action["media"]): Action => ({
  type: "action",
  id: "a1",
  at: "2026-01-01T10:00:00.000Z",
  kind: "read",
  status: "ok",
  title: "read /tmp/shot.png",
  media,
});

const png = Buffer.from("pixels");
const sha = NodeCrypto.createHash("sha256").update(png).digest("hex");

describe("extractMedia", () => {
  it("keeps each image as its hash and size, and its bytes once apart", () => {
    const data = png.toString("base64");
    const { entries, blobs } = extractMedia([
      action([
        { mime: "image/png", data },
        { mime: "image/png", data },
      ]),
    ]);
    assert.deepStrictEqual((entries[0] as Action).media, [
      { mime: "image/png", sha256: sha, bytes: png.length },
      { mime: "image/png", sha256: sha, bytes: png.length },
    ]);
    assert.deepStrictEqual([...blobs.keys()], [sha]);
  });

  it("drops what the bucket won't keep: SVG, oversized", () => {
    const big = Buffer.alloc(LIMITS.mediaBytes + 1).toString("base64");
    const { entries, blobs } = extractMedia([
      action([
        { mime: "image/svg+xml", data: png.toString("base64") },
        { mime: "image/png", data: big },
      ]),
    ]);
    assert.isUndefined((entries[0] as Action).media);
    assert.strictEqual(blobs.size, 0);
  });
});

describe("admitThread", () => {
  const record = (media: Action["media"]) =>
    buildThreadRecord({
      thread: { id: "t1", title: "t", source: "t3", provider: null, origin: null, parent: null },
      entries: [action(media)],
      labels: {},
      takenAt: "2026-01-01T11:00:00.000Z",
      toolreaderVersion: "0.1.0",
      maxOutput: 8192,
    });

  it("takes images by hash", () => {
    const r = admitThread(record([{ mime: "image/png", sha256: sha, bytes: 6 }]));
    assert.strictEqual(r._tag, "Success");
  });

  it("refuses image bytes and images without a hash", () => {
    const bytes = record([{ mime: "image/png", sha256: sha }]);
    (bytes.entries[0] as { media: unknown }).media = [
      { mime: "image/png", sha256: sha, data: "eA==" },
    ];
    for (const r of [admitThread(bytes), admitThread(record([{ mime: "image/png" }]))]) {
      assert.strictEqual(r._tag, "Failure");
      if (r._tag === "Failure") assert.include(r.failure.detail, "entries.0.media");
    }
  });
});
