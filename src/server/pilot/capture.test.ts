// Only synthetic protocol and hook inputs; no real model or personal session files.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodePath from "node:path";
import { describe, it, expect } from "vite-plus/test";
import { recordHook, StreamRoutes, StreamCapture, capturedArtifacts } from "./capture.ts";
import { inspectArtifact } from "./Pilot.ts";

const session = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
describe("private hook and app-server capture", () => {
  it("routes an approval question and its exact client answer to one session without capturing auth", () => {
    const routes = new StreamRoutes();
    expect(
      routes.event(
        "client",
        JSON.stringify({
          id: 1,
          method: "account/login/start",
          params: { apiKey: "not-recorded" },
        }),
      ),
    ).toEqual([]);
    expect(
      routes.event(
        "server",
        JSON.stringify({ id: 1, result: { account: { secret: "not-recorded" } } }),
      ),
    ).toEqual([]);
    const question = {
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: { threadId: session, itemId: "command-a", reason: "question" },
    };
    expect(routes.event("server", JSON.stringify(question))[0]?.payload.message).toEqual(question);
    const answer = { id: 7, result: { decision: "decline" } };
    expect(routes.event("client", JSON.stringify(answer))).toEqual([
      { session, type: "response", payload: { direction: "client", message: answer } },
    ]);
    expect(routes.event("client", JSON.stringify(answer))).toEqual([]);
  });
  it("retains thread/start input once the server assigns its session id", () => {
    const routes = new StreamRoutes();
    const start = {
      id: 3,
      method: "thread/start",
      params: { developerInstructions: "keep this context" },
    };
    expect(routes.event("client", JSON.stringify(start))).toEqual([]);
    const events = routes.event(
      "server",
      JSON.stringify({ id: 3, result: { thread: { id: session } } }),
    );
    expect(events).toHaveLength(2);
    expect(events[0]?.payload.message).toEqual(start);
  });
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
      expect(await capturedArtifacts(home, session)).toHaveLength(20);
      await expect(recordHook(home, '{"hook_event_name":"PermissionRequest"}')).rejects.toThrow();
    } finally {
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  });
  it("writes one complete stream artifact with ordered requests and decisions", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "stream-capture-"));
    try {
      const capture = new StreamCapture(home);
      const routes = new StreamRoutes();
      const events = routes.event(
        "server",
        JSON.stringify({
          id: 9,
          method: "item/commandExecution/requestApproval",
          params: { threadId: session, itemId: "call-a" },
        }),
      );
      events.push(
        ...routes.event("client", JSON.stringify({ id: 9, result: { decision: "decline" } })),
      );
      await Promise.all(events.map((e) => capture.record(e)));
      await capture.flush();
      const files = await capturedArtifacts(home, session);
      expect(files).toHaveLength(1);
      const lines = (await NodeFSP.readFile(files[0]!.file, "utf8"))
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(lines).toHaveLength(3);
      expect(lines[1].payload.message.params.itemId).toBe("call-a");
      expect(lines[2].payload.message.result.decision).toBe("decline");
    } finally {
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  });
});
