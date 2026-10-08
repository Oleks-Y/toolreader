import { assert, describe, it } from "@effect/vitest";

import { claudeTranscriptMeta, claudeTranscriptToRows } from "./claudeTranscript.ts";
import type { Action, Entry } from "./domain.ts";
import { normalize } from "./normalize.ts";

let n = 0;
const at = () => `2026-10-07T12:00:${String(++n).padStart(2, "0")}.000Z`;
const base = { sessionId: "s1", cwd: "/repo", isSidechain: false };
// Records as Claude Code writes them (captured from ~/.claude/projects, trimmed).
const user = (content: unknown, extra: object = {}) =>
  JSON.stringify({
    ...base,
    type: "user",
    uuid: `u${n}`,
    timestamp: at(),
    message: { role: "user", content },
    ...extra,
  });
const assistant = (...content: unknown[]) =>
  JSON.stringify({
    ...base,
    type: "assistant",
    uuid: `a${n}`,
    timestamp: at(),
    message: { role: "assistant", content },
  });
const use = (id: string, name: string, input: object) => ({ type: "tool_use", id, name, input });
const result = (id: string, content: unknown, is_error = false) =>
  user([{ type: "tool_result", tool_use_id: id, content, is_error }]);

const lines = [
  JSON.stringify({ type: "ai-title", aiTitle: "Fix the build", sessionId: "s1" }),
  user("<command-name>/model</command-name>"),
  user([{ type: "text", text: "Run the deep-research workflow." }], { isMeta: true }),
  user("fix the build"),
  user("<task-notification>agent finished</task-notification>"),
  user("<template>\n  <p>hi</p>\n</template> make this a component"),
  "not json",
  assistant({ type: "thinking", thinking: "Check the test first", signature: "x" }),
  assistant(use("t1", "Bash", { command: "pnpm test", description: "Run tests" })),
  result("t1", "Exit code 1\n1 failed", true),
  assistant(use("t2", "Edit", { file_path: "/repo/src/a.ts", old_string: "a", new_string: "b" })),
  result("t2", "The file /repo/src/a.ts has been updated successfully."),
  assistant(use("t3", "mcp__t3-code__t3_thread_list", { limit: 5 })),
  result("t3", [{ type: "text", text: "[]" }]),
  JSON.stringify({
    ...base,
    type: "assistant",
    isSidechain: true,
    timestamp: at(),
    message: { content: [use("x1", "Bash", { command: "ls" })] },
  }),
  JSON.stringify({
    ...base,
    type: "system",
    subtype: "compact_boundary",
    uuid: "c1",
    timestamp: at(),
  }),
  user("Summary of the earlier conversation", { isCompactSummary: true }),
  JSON.stringify({
    ...base,
    type: "system",
    subtype: "api_error",
    uuid: "e1",
    timestamp: at(),
    error: { message: "Connection error." },
  }),
  assistant({ type: "text", text: "Fixed." }, use("t4", "Bash", { command: "pnpm build" })),
  JSON.stringify({ type: "custom-title", customTitle: "Build fix", sessionId: "s1" }),
];
// Compaction can re-append records already in the file.
lines.push(lines[3]!, lines[7]!);

const actions = (entries: Entry[]) => entries.filter((e): e is Action => e.type === "action");

describe("claudeTranscript", () => {
  it("reads the session id, directory and the newest title", () => {
    assert.deepStrictEqual(claudeTranscriptMeta(lines), {
      id: "s1",
      cwd: "/repo",
      title: "Build fix",
      createdAt: "2026-10-07T12:00:01.000Z",
    });
    // Without a title record, the first prompt the user typed.
    assert.strictEqual(claudeTranscriptMeta(lines.slice(1, 4))?.title, "fix the build");
    assert.isNull(claudeTranscriptMeta(["{}", "garbage"]));
  });

  it("turns tool calls, messages and events into entries", () => {
    const { activities, messages } = claudeTranscriptToRows(lines);
    const entries = normalize(activities, messages, { root: "/repo" });
    assert.deepStrictEqual(
      entries
        .filter((e) => e.type === "message")
        .map((e) => e.type === "message" && [e.role, e.text]),
      [
        ["user", "fix the build"],
        ["user", "<template>\n  <p>hi</p>\n</template> make this a component"],
        ["reasoning", "Check the test first"],
        ["assistant", "Fixed."],
      ],
    );
    const [test, edit, mcp, build] = actions(entries);
    assert.strictEqual(actions(entries).length, 4, "the sidechain call is not this session's");
    assert.include(test, { kind: "test", status: "failed", exitCode: 1, command: "pnpm test" });
    assert.include(edit, { kind: "edit", status: "ok", title: "src/a.ts" });
    assert.strictEqual(edit?.files?.[0]?.added, 1);
    assert.include(mcp, { kind: "tool", status: "ok", output: "[]" });
    assert.include(mcp?.title, "t3-code · t3_thread_list");
    assert.include(build, { status: "running" }, "no result yet");
    assert.deepStrictEqual(
      entries.filter((e) => e.type === "event").map((e) => e.type === "event" && e.text),
      ["Context compacted", "API error: Connection error."],
    );
  });
});
