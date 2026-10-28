// Only synthetic hook inputs; no real model or personal session files.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodePath from "node:path";
import { describe, it, expect } from "vite-plus/test";
import { recordHook, capturedArtifacts } from "./capture.ts";
import { inspectArtifact } from "./Pilot.ts";

const session = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
describe("private hook capture", () => {
  it("keeps concurrent hook artifacts complete and selects only the requested session", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hook-capture-"));
    try {
      const files = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          recordHook(
            home,
            JSON.stringify({
              session_id: session,
              hook_event_name: "PermissionRequest",
              turn_id: "turn-a",
              tool_input: { command: `printf ${i}`, description: "question" },
            }),
          ),
        ),
      );
      expect(new Set(files).size).toBe(20);
      for (const file of files) expect((await inspectArtifact(file, session)).events).toBe(2);
      await recordHook(
        home,
        JSON.stringify({
          session_id: other,
          hook_event_name: "PostToolUse",
          tool_response: { output: "other" },
        }),
      );
      const legacy = NodePath.join(home, "toolreader-events", session, "app-server");
      await NodeFSP.mkdir(legacy, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(legacy, "old-stream.jsonl"), "broken legacy data");
      expect(await capturedArtifacts(home, session)).toHaveLength(20);
      await expect(recordHook(home, '{"hook_event_name":"PermissionRequest"}')).rejects.toThrow();
    } finally {
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  });
});
