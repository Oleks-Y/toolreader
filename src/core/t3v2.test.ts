import { assert, describe, it } from "@effect/vitest";

import type { Action, Entry } from "./domain.ts";
import { normalize } from "./normalize.ts";
import { turnItemsToRows, type TurnItemRow } from "./t3v2.ts";

let ordinal = 0;
// Payloads as T3 writes them (captured from a nightly statev2.sqlite, trimmed).
const item = (
  id: string,
  type: string,
  fields: Record<string, unknown>,
  status = "completed",
): TurnItemRow => {
  ordinal++;
  const startedAt = `2026-10-05T12:00:${String(ordinal).padStart(2, "0")}.000Z`;
  return {
    id,
    type,
    status,
    ordinal,
    updatedAt: startedAt,
    payload: JSON.stringify({ id, type, status, title: null, startedAt, ...fields }),
  };
};

const rows = [
  item("migration:v1:turn-item:u0", "user_message", { text: "imported from V1" }),
  item("u1", "user_message", { text: "fix the build" }),
  item("r1", "reasoning", { text: "Check the test first" }),
  item(
    "c1",
    "command_execution",
    { input: "pnpm test", output: "Error: Exit code 1\n1 failed" },
    "failed",
  ),
  item("c2", "command_execution", { input: "git status", output: "clean", exitCode: 0 }),
  item("w1", "file_change", {
    fileName: "/repo/src/new.ts",
    diffStr: JSON.stringify({ type: "create", filePath: "/repo/src/new.ts", content: "a\nb" }),
  }),
  item("e1", "file_change", {
    fileName: "/repo/src/a.ts",
    diffStr: JSON.stringify({
      filePath: "/repo/src/a.ts",
      oldString: "x",
      newString: "y",
      originalFile: "x",
    }),
  }),
  item("e2", "file_change", { fileName: "/repo/src/b.ts", diffStr: "@@ -1,1 +1,1 @@\n-a\n+b" }),
  item(
    "e3",
    "file_change",
    { fileName: "/repo/src/c.ts", diffStr: "<tool_use_error>String not found</tool_use_error>" },
    "failed",
  ),
  item("d1", "dynamic_tool", { toolName: "Read", input: { file_path: "/repo/src/a.ts" } }),
  item("d2", "dynamic_tool", {
    toolName: "t3-code.t3_thread_list",
    input: { limit: 5 },
    output: { threads: [] },
  }),
  item("s1", "web_search", { patterns: ["https://example.com/doc.md"] }),
  item("s2", "web_search", {
    patterns: ["effect schema"],
    results: [{ url: "https://effect.website", snippet: "docs" }],
  }),
  item(
    "a1",
    "subagent",
    { title: "Measure causes", prompt: "count them", result: null },
    "cancelled",
  ),
  item("x1", "error", { failure: { class: "provider_error", message: "overloaded" } }),
  item("k1", "checkpoint", { files: [] }),
  item("q1", "assistant_message", { text: "Fixed." }),
  item("u2", "user_message", { not: "decodable", text: 42 }),
];

const entries: Entry[] = (() => {
  const { activities, messages } = turnItemsToRows(rows);
  return normalize(activities, messages, { root: "/repo" });
})();
const byId = new Map(entries.map((e) => [e.id, e]));
const action = (id: string) => byId.get(id) as Action;

describe("turnItemsToRows", () => {
  it("keeps order, skips imported and bookkeeping items, and tolerates odd payloads", () => {
    assert.deepStrictEqual(
      entries.map((e) => e.id),
      ["u1", "r1", "c1", "c2", "w1", "e1", "e2", "e3", "d1", "d2", "s1", "s2", "a1", "x1", "q1"],
    );
  });

  it("reads exit codes from the field or Claude's output text", () => {
    assert.deepStrictEqual([action("c1").status, action("c1").exitCode], ["failed", 1]);
    assert.deepStrictEqual([action("c2").status, action("c2").exitCode], ["ok", 0]);
  });

  it("turns Claude's file results and unified diffs into file changes", () => {
    const files = (id: string) =>
      action(id).files?.map((f) => [f.path, f.added, f.removed, f.isNew]);
    assert.deepStrictEqual(files("w1"), [["src/new.ts", 2, 0, true]]);
    assert.deepStrictEqual(files("e1"), [["src/a.ts", 1, 1, false]]);
    assert.deepStrictEqual(files("e2"), [["src/b.ts", 1, 1, false]]);
    assert.strictEqual(action("e3").status, "failed");
    assert.include(action("e3").output, "String not found");
  });

  it("names tools, web calls and subagents like their V1 counterparts", () => {
    assert.strictEqual(action("d1").title, "read src/a.ts");
    assert.include(action("d2").title, "t3-code.t3_thread_list");
    assert.include(action("d2").output, "threads");
    assert.strictEqual(action("s1").title, "fetch https://example.com/doc.md");
    assert.strictEqual(action("s2").title, 'web search "effect schema"');
    assert.deepStrictEqual([action("a1").kind, action("a1").status], ["agent", "failed"]);
    const error = byId.get("x1");
    assert.deepStrictEqual(error?.type === "event" && [error.tone, error.text], [
      "error",
      "Runtime error: overloaded",
    ]);
  });
});
