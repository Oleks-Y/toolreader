import * as Schema from "effect/Schema";
import { describe, it, expect } from "vite-plus/test";
import {
  archiveEvent,
  archiveSession,
  archivePeers,
  archiveReminder,
  ArchiveStart,
} from "./codexArchive.ts";

const decodeStart = Schema.decodeUnknownSync(ArchiveStart);

const own = "11111111-1111-4111-8111-111111111111";
const peer = "22222222-2222-4222-8222-222222222222";
describe("private Codex archive", () => {
  it("accepts rollout and hook uploads and rejects the removed stream source", () => {
    const start = { sessionId: own, rootId: own, sha256: "a".repeat(64), bytes: 10, parts: 1 };
    for (const source of ["rollout", "hook"])
      expect(decodeStart({ ...start, source }).source).toBe(source);
    expect(decodeStart(start).source).toBeUndefined();
    expect(() => decodeStart({ ...start, source: "app-server" })).toThrow();
  });
  it("keeps unknown event fields and full tool inputs and output", () => {
    const raw = {
      type: "response_item",
      timestamp: "2026-10-28",
      extra: { unseen: true },
      payload: {
        type: "function_call_output",
        call_id: "a",
        output: "x".repeat(120_000),
        future: [1, 2],
      },
    };
    expect(archiveEvent(JSON.stringify(raw), 3)).toEqual({
      seq: 3,
      type: raw.type,
      at: raw.timestamp,
      raw,
    });
    expect(archiveEvent('{"type":"future","unknown":42}', 4).raw).toEqual({
      type: "future",
      unknown: 42,
    });
  });
  it("rejects partial JSON and mismatched metadata rather than discarding it", () => {
    expect(() => archiveEvent('{"type":', 2)).toThrow();
    expect(() => archiveSession('{"type":"response_item"}')).toThrow();
    expect(archiveSession(JSON.stringify({ type: "session_meta", payload: { id: own } }))).toBe(
      own,
    );
  });
  it("selects explicit direct message UUIDs, not UUIDs merely mentioned in prompts or searches", () => {
    const message = {
      payload: {
        type: "function_call",
        name: "mcp__codex_app__send_message_to_thread",
        arguments: JSON.stringify({ threadId: peer, prompt: own }),
      },
    };
    expect(archivePeers(message)).toEqual([peer]);
    expect(
      archivePeers({ payload: { type: "inter_agent_message", sender_thread_id: peer } }),
    ).toEqual([peer]);
    expect(archivePeers({ payload: { type: "message", content: peer } })).toEqual([]);
    expect(archivePeers({ payload: { ...message.payload, name: "read_thread" } })).toEqual([]);
  });
  it("adds context after commits and PR updates and at session start", () => {
    for (const event of [
      { hook_event_name: "SessionStart" },
      { hook_event_name: "PostToolUse", tool_input: { command: "git -C /repo commit -m change" } },
      {
        hook_event_name: "PostToolUse",
        tool_input: { cmd: "gh pr edit 78 --body-file /tmp/body" },
      },
      { hook_event_name: "PostToolUse", tool_name: "mcp__github__create_pull_request" },
    ])
      expect(
        archiveReminder(JSON.stringify(event))?.hookSpecificOutput.additionalContext,
      ).toContain("toolreader pilot sync");
    expect(
      archiveReminder('{"hook_event_name":"PostToolUse","tool_input":{"command":"git status"}}'),
    ).toBeNull();
  });
});
