import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { CodexThreadRead, codexThreadToRows, scanItemTimes, toCanonicalItemType } from "./codex.ts";
import { normalize } from "./normalize.ts";

const decodeRead = Schema.decodeUnknownSync(CodexThreadRead);

const read = decodeRead({
  thread: {
    id: "t1",
    cwd: "/repo",
    createdAt: 1_790_000_000,
    updatedAt: 1_790_000_100,
    path: "/rollout.jsonl",
    brandNewField: { anything: true },
    turns: [
      {
        id: "turn1",
        startedAt: 1_790_000_001,
        items: [
          { type: "userMessage", id: "u1", content: [{ type: "text", text: "fix the build" }] },
          { type: "reasoning", id: "r1", summary: ["Check the failing test first"], content: [] },
          {
            type: "commandExecution",
            id: "c1",
            status: "failed",
            command: "/bin/zsh -lc 'pnpm test'",
            exitCode: 1,
            aggregatedOutput: "1 failed",
            commandActions: [{ type: "unknown" }],
          },
          {
            type: "fileChange",
            id: "f1",
            status: "completed",
            changes: [{ path: "/repo/src/a.ts", kind: { type: "update" }, diff: "@@\n-a\n+b" }],
          },
          { type: "sleep", id: "s1", durationMs: 5 },
          { type: "agentMessage", id: "a1", text: "Fixed." },
          { notAnItem: true },
        ],
      },
    ],
  },
});

describe("codex", () => {
  it("canonicalizes item types like T3 does", () => {
    assert.deepStrictEqual(
      [
        "commandExecution",
        "CommandExecution",
        "fileChange",
        "mcpToolCall",
        "webSearch",
        "collabAgentToolCall",
        "contextCompaction",
        "sleep",
      ].map(toCanonicalItemType),
      [
        "command_execution",
        "command_execution",
        "file_change",
        "mcp_tool_call",
        "web_search",
        "collab_agent_tool_call",
        "context_compaction",
        "unknown",
      ],
    );
  });

  it("scans the first timestamp each item id appears at", () => {
    const times = scanItemTimes([
      '{"timestamp":"2026-01-01T00:00:01.000Z","type":"response_item","payload":{"type":"function_call","call_id":"c1"}}',
      '{"timestamp":"2026-01-01T00:00:09.000Z","type":"event_msg","payload":{"type":"item_completed","item":{"id":"c1"}}}',
      'not json {"id":"zzz"}',
      '{"timestamp":"2026-01-01T00:00:10.000Z","type":"event_msg","payload":{"item":{"id":"f1","type":"FileChange"}}}',
    ]);
    assert.deepStrictEqual(
      [...times],
      [
        ["c1", "2026-01-01T00:00:01.000Z"],
        ["f1", "2026-01-01T00:00:10.000Z"],
      ],
    );
  });

  it("turns thread/read items into entries the normalizer understands", () => {
    const times = new Map([
      ["c1", "2026-01-01T00:00:05.000Z"],
      ["f1", "2026-01-01T00:00:06.000Z"],
    ]);
    const { activities, messages } = codexThreadToRows(read, times);
    assert.deepStrictEqual(
      messages.map((m) => m.role),
      ["user", "reasoning", "assistant"],
    );
    assert.strictEqual(messages[1]?.text, "Check the failing test first");

    const entries = normalize(activities, messages, { root: "/repo" });
    const actions = entries.flatMap((e) => (e.type === "action" ? [e] : []));
    assert.deepStrictEqual(
      actions.map((a) => [a.id, a.kind, a.status, a.title, a.at]),
      [
        ["c1", "run", "failed", "pnpm test", "2026-01-01T00:00:05.000Z"],
        ["f1", "edit", "ok", "src/a.ts", "2026-01-01T00:00:06.000Z"],
      ],
    );
    // Items without a rollout timestamp inherit the previous one, so order stays stable.
    assert.strictEqual(messages[2]?.at, "2026-01-01T00:00:06.000Z");
  });
});
