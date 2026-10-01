import { assert, describe, it } from "@effect/vitest";

import { readItem, readRollout, rolloutMeta } from "./rolloutThread.ts";

let ordinal = 0;
const line = (type: string, payload: object) =>
  JSON.stringify({
    timestamp: `2026-01-01T00:00:${String(ordinal).padStart(2, "0")}.000Z`,
    ordinal: ordinal++,
    type,
    payload,
  });
const meta = (extra: object = {}) =>
  line("session_meta", {
    id: "s1",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/repo",
    originator: "codex_exec",
    source: "exec",
    ...extra,
  });
const started = (turn_id: string) =>
  line("event_msg", { type: "task_started", turn_id, started_at: 1_767_225_600 });
const completed = (turn_id: string, item: object) =>
  line("event_msg", { type: "item_completed", turn_id, item });

describe("rolloutThread", () => {
  it("maps rollout items to app-server items", () => {
    assert.deepStrictEqual(
      readItem({
        type: "CommandExecution",
        id: "c1",
        command: ["/bin/zsh", "-lc", "git diff HEAD^ HEAD"],
        cwd: "file:///repo",
        parsed_cmd: [{ type: "list_files", cmd: "ls", path: null }],
        aggregated_output: "x",
        exit_code: 0,
        status: "in_progress",
      }),
      {
        type: "commandExecution",
        id: "c1",
        command: "/bin/zsh -lc 'git diff HEAD''^ HEAD'",
        cwd: "/repo",
        commandActions: [{ type: "listFiles", command: "ls", path: null }],
        aggregatedOutput: "x",
        exitCode: 0,
        status: "inProgress",
      },
    );
    assert.deepStrictEqual(
      readItem({
        type: "FileChange",
        id: "f1",
        changes: {
          "/repo/b.ts": {
            type: "update",
            unified_diff: "@@ -1 +1 @@\n-a\n+b",
            move_path: "/repo/c.ts",
          },
          "/repo/a.ts": { type: "add", content: "new\n" },
        },
        status: "completed",
      })?.["changes"],
      [
        { path: "/repo/a.ts", kind: { type: "add" }, diff: "new\n" },
        {
          path: "/repo/b.ts",
          kind: { type: "update", move_path: "/repo/c.ts" },
          diff: "@@ -1 +1 @@\n-a\n+b\n\nMoved to: /repo/c.ts",
        },
      ],
    );
    assert.deepStrictEqual(
      readItem({ type: "Extension", kind: "clock.sleep", id: "x", durationMs: 5 }),
      {
        type: "sleep",
        id: "x",
        durationMs: 5,
      },
    );
    assert.deepStrictEqual(
      readItem({
        type: "AgentMessage",
        id: "a",
        content: [
          { type: "Text", text: "Hi" },
          { type: "Text", text: "!" },
        ],
      }),
      { type: "agentMessage", id: "a", text: "Hi!" },
    );
    assert.isNull(readItem({ notAnItem: true }));
  });

  it("groups items into turns, keeps a repeated item's last version in its first place, and skips bad lines", () => {
    ordinal = 0;
    const lines = [
      meta(),
      started("t1"),
      completed("t1", { type: "UserMessage", id: "u1", content: [{ type: "text", text: "go" }] }),
      completed("t1", { type: "Reasoning", id: "r1", summary_text: ["a"], raw_content: [] }),
      "{ not json",
      line("event_msg", { type: "item_completed", turn_id: "t1", item: "garbage" }),
      completed("t1", {
        type: "AgentMessage",
        id: "m1",
        content: [{ type: "Text", text: "done" }],
      }),
      completed("t1", { type: "Reasoning", id: "r1", summary_text: ["a", "b"], raw_content: [] }),
      line("event_msg", { type: "task_complete", turn_id: "t1" }),
    ];
    const session = readRollout(lines, "/r.jsonl")!;
    const [turn] = session.read.thread.turns ?? [];
    assert.strictEqual(turn?.status, "completed");
    assert.deepStrictEqual(
      turn?.items.map((i) => [(i as { id: string }).id, (i as { summary?: string[] }).summary]),
      [
        ["u1", undefined],
        ["r1", ["a", "b"]],
        ["m1", undefined],
      ],
    );
    assert.strictEqual(session.read.thread.preview, "go");
  });

  it("hides history a delegated thread inherited, and flags subagents", () => {
    ordinal = 0;
    const lines = [
      meta({ subagent_history_start_ordinal: 3 }),
      started("parent"),
      completed("parent", {
        type: "UserMessage",
        id: "old",
        content: [{ type: "text", text: "parent" }],
      }),
      started("t1"),
      completed("t1", {
        type: "UserMessage",
        id: "new",
        content: [{ type: "text", text: "child" }],
      }),
    ];
    const session = readRollout(lines, "/r.jsonl")!;
    assert.deepStrictEqual(
      session.read.thread.turns?.flatMap((t) => t.items.map((i) => (i as { id: string }).id)),
      ["new"],
    );
    assert.isTrue(rolloutMeta(meta({ source: { subagent: { other: "guardian" } } }))?.subagent);
    assert.isFalse(rolloutMeta(meta())?.subagent);
    assert.isNull(rolloutMeta(started("t1")));
    assert.isNull(readRollout([started("t1")], "/r.jsonl"));
  });
});
