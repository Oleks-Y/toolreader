// A selected Codex peer is imported even when it has no action in the linking repository.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";

import { describe, expect, it } from "vite-plus/test";
import { normalizedPilotRecord } from "./normalized.ts";

const id = "11111111-1111-4111-8111-111111111111";
const parent = "22222222-2222-4222-8222-222222222222";
const source = {
  id,
  file: "/temporary/selected.jsonl",
  sourceSha256: "a".repeat(64),
  parent,
};
const takenAt = "2026-10-28T00:00:00.000Z";

describe("selected normalized Codex history", () => {
  it("keeps an actionless selected peer with its parent and source version", () => {
    const text = [
      { timestamp: takenAt, type: "session_meta", payload: { id, cwd: "/repo" } },
      {
        timestamp: takenAt,
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-1", started_at: 1793145600 },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");
    const made = normalizedPilotRecord({ source, text, home: "/home/test", takenAt });
    expect(made?.record.thread.id).toBe(`codex:${id}`);
    expect(made?.record.thread.parent).toBe(`codex:${parent}`);
    expect(made?.record.origin?.sha256).toBe(source.sourceSha256);
    expect(made?.record.entries).toEqual([]);
  });

  it("finds the parent from the selected rollout when the caller does not supply it", () => {
    const text = [
      {
        timestamp: takenAt,
        type: "session_meta",
        payload: { id, cwd: "/repo", parent_thread_id: parent },
      },
      {
        timestamp: takenAt,
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-1", started_at: 1793145600 },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");
    const made = normalizedPilotRecord({
      source: { id, file: source.file, sourceSha256: source.sourceSha256 },
      text,
      home: "/home/test",
      takenAt,
    });
    expect(made?.record.thread.parent).toBe(`codex:${parent}`);
  });

  it("uses the existing normalization path on a recorded Codex fixture", async () => {
    const text = await NodeFSP.readFile("src/server/fixtures/codex-exec.rollout.jsonl", "utf8");
    const fixtureId = "01a0f7a1-d93a-77b1-b192-7c9ad47b7439";
    const made = normalizedPilotRecord({
      source: { ...source, id: fixtureId, parent: null },
      text,
      home: "/home/test",
      takenAt,
    });
    expect(made?.record.thread.id).toBe(`codex:${fixtureId}`);
    expect(made?.record.thread.parent).toBeNull();
    expect(made?.record.entries.length).toBeGreaterThan(0);
    expect(made?.record.formatVersion).toBe(1);
    expect(
      normalizedPilotRecord({ source: { ...source, id }, text, home: "/home/test", takenAt }),
    ).toBeNull();
  });
});
