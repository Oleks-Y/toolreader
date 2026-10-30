// No model or live session data. These files use the same JSONL envelope as local Codex rollouts.
// Byte-level snapshot checks use Node file handles.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodePath from "node:path";
import { describe, it, expect } from "vite-plus/test";
import { findArtifact, snapshotArtifact, inspectArtifact } from "./Pilot.ts";

const own = "11111111-1111-4111-8111-111111111111";
const peer = "22222222-2222-4222-8222-222222222222";
describe("selected Codex snapshots", () => {
  it("reads selected files only and preserves available bytes across appends", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pilot-"));
    try {
      const sessions = NodePath.join(dir, "sessions");
      await NodeFSP.mkdir(sessions);
      const source = NodePath.join(sessions, `rollout-now-${own}.jsonl`);
      const rows = [
        { type: "session_meta", payload: { id: own } },
        {
          type: "response_item",
          payload: {
            type: "function_call",
            name: "send_input",
            arguments: JSON.stringify({ id: peer, message: "context" }),
          },
        },
        {
          type: "response_item",
          payload: { type: "function_call_output", output: "z".repeat(5 * 1024 * 1024) },
        },
      ];
      const original = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
      await NodeFSP.writeFile(source, original);
      // A broken unrelated session must never be parsed or selected.
      await NodeFSP.writeFile(NodePath.join(sessions, "rollout-unrelated.jsonl"), "broken");
      expect(await findArtifact(dir, own)).toBe(source);
      const target = NodePath.join(dir, "snapshot.jsonl");
      const result = await snapshotArtifact(source, target);
      await NodeFSP.appendFile(source, "partial");
      expect(result.bytes).toBe(Buffer.byteLength(original));
      expect(await NodeFSP.readFile(target, "utf8")).toBe(original);
      expect(await inspectArtifact(target, own)).toEqual({ events: 3, peers: [peer] });
      await expect(inspectArtifact(source, own)).rejects.toThrow();
      await expect(inspectArtifact(target, peer)).rejects.toThrow();
      await expect(findArtifact(dir, peer)).rejects.toThrow();
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });
});
