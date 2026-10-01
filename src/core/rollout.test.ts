import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { CodexThreadRead, codexThreadToRows } from "./codex.ts";
import type { Action } from "./domain.ts";
import { normalize } from "./normalize.ts";
import { parsePatch, scanRollout, shellJoin } from "./rollout.ts";

const decodeRead = Schema.decodeUnknownSync(CodexThreadRead);

// Rollout lines as Codex writes them: timestamp first, payload type first.
let second = 0;
const at = () => `2026-01-01T00:00:${String(second++).padStart(2, "0")}.000Z`;
const item = (payload: object) =>
  JSON.stringify({ timestamp: at(), type: "response_item", payload });
const event = (payload: object) => JSON.stringify({ timestamp: at(), type: "event_msg", payload });
const call = (call_id: string, name: string, args: object, extra: object = {}) =>
  item({ type: "function_call", name, arguments: JSON.stringify(args), call_id, ...extra });
const custom = (call_id: string, name: string, input: string) =>
  item({ type: "custom_tool_call", status: "completed", call_id, name, input });
const output = (call_id: string, output: unknown) =>
  item({ type: "function_call_output", call_id, output });
const customOutput = (call_id: string, output: unknown) =>
  item({ type: "custom_tool_call_output", call_id, output });
const completed = (turn_id: string, it: object) =>
  event({ type: "item_completed", turn_id, item: it });

/** One turn read back through thread/read, which keeps only the items given here. */
const threadRead = (items: object[], status = "completed") =>
  decodeRead({
    thread: {
      id: "t",
      cwd: "/repo",
      createdAt: 1_767_225_600,
      updatedAt: 1_767_225_700,
      turns: [{ id: "turn-1", status, items }],
    },
  });

const actionsOf = (lines: string[], items: object[], status?: string) => {
  const { activities, messages } = codexThreadToRows(threadRead(items, status), scanRollout(lines));
  const entries = normalize(activities, messages, { root: "/repo" });
  return {
    entries,
    actions: entries.flatMap((e): Action[] => (e.type === "action" ? [e] : [])),
  };
};
const user = { type: "userMessage", id: "item-1", content: [{ type: "text", text: "go" }] };
const done = { type: "agentMessage", id: "item-2", text: "Done." };

describe("rollout", () => {
  it("recovers commands thread/read drops, in place and with their exit code", () => {
    second = 0;
    const lines = [
      event({ type: "task_started", turn_id: "turn-1" }),
      completed("turn-1", { type: "UserMessage", id: "item-1" }),
      call("c1", "exec_command", { cmd: "pnpm test", workdir: "/repo" }),
      output(
        "c1",
        "Chunk ID: 1\nWall time: 9 seconds\nProcess exited with code 1\nOutput:\n1 failed\n",
      ),
      // Long-running: later output arrives through write_stdin.
      call("c2", "exec_command", { cmd: "pnpm build" }),
      output("c2", "Chunk ID: 2\nProcess running with session ID 41\nOutput:\nbuilding\n"),
      call("c3", "write_stdin", { session_id: 41, chars: "" }),
      output("c3", "Chunk ID: 3\nProcess exited with code 0\nOutput:\ndone\n"),
      completed("turn-1", { type: "AgentMessage", id: "item-2" }),
      event({ type: "task_complete", turn_id: "turn-1" }),
    ];
    const { entries, actions } = actionsOf(lines, [user, done]);
    assert.deepStrictEqual(
      actions.map((a) => [a.id, a.kind, a.status, a.title, a.exitCode, a.output]),
      [
        ["c1", "test", "failed", "pnpm test", 1, "1 failed\n"],
        ["c2", "build", "ok", "pnpm build", 0, "building\ndone\n"],
      ],
    );
    assert.deepStrictEqual(
      entries.map((e) => e.id),
      ["item-1", "c1", "c2", "item-2"],
    );
    assert.strictEqual(actions[0]?.at, "2026-01-01T00:00:02.000Z");
  });

  it("reads 0.4x shell argv, JSON outputs and sandbox denials", () => {
    const lines = [
      call("s1", "shell", { command: ["bash", "-lc", "rg -n 'a b' src"] }),
      output("s1", JSON.stringify({ output: "", metadata: { exit_code: 1 } })),
      call("s2", "shell", { command: ["bash", "-lc", "git commit -m 'fix: x'"] }),
      output("s2", "failed in sandbox MacosSeatbelt with execution error: Denied"),
    ];
    const { actions } = actionsOf(lines, []);
    assert.deepStrictEqual(
      actions.map((a) => [a.kind, a.status, a.title, a.noMatch]),
      [
        ["search", "ok", 'search "a b" in src', true],
        ["git", "failed", "git commit -m fix: x", undefined],
      ],
    );
  });

  it("turns apply_patch into file changes, and shows why a patch was rejected", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: /repo/src/a.ts",
      "@@ function a",
      " keep",
      "-old",
      "+new",
      "@@",
      "-x",
      "+y",
      "+z",
      "*** End of File",
      "*** Add File: /repo/src/b.ts",
      "+hello",
      "*** Delete File: /repo/src/c.ts",
      "*** End Patch",
    ].join("\n");
    const lines = [
      custom("p1", "apply_patch", patch),
      customOutput("p1", "Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess.\n"),
      custom(
        "p2",
        "apply_patch",
        "*** Begin Patch\n*** Update File: d.ts\n@@\n-a\n+b\n*** End Patch",
      ),
      customOutput("p2", "apply_patch verification failed: Failed to find expected lines in d.ts"),
    ];
    const { actions } = actionsOf(lines, []);
    const [ok, rejected] = actions;
    assert.deepStrictEqual(
      ok?.files?.map((f) => [f.path, f.added, f.removed, f.isNew, f.isDeleted, f.exactLines]),
      [
        ["src/a.ts", 3, 2, false, false, false],
        ["src/b.ts", 1, 0, true, false, true],
        ["src/c.ts", 0, 0, false, true, true],
      ],
    );
    // Bare apply_patch hunks get consecutive made-up numbers, so the diff parses.
    assert.strictEqual(
      ok?.files?.[0]?.diff,
      "@@ -1,2 +1,2 @@ function a\n keep\n-old\n+new\n@@ -3,1 +3,2 @@\n-x\n+y\n+z",
    );
    assert.deepStrictEqual(
      [rejected?.status, rejected?.output],
      ["failed", "apply_patch verification failed: Failed to find expected lines in d.ts"],
    );
    assert.deepStrictEqual(
      parsePatch("*** Update File: a.ts\n*** Move to: b.ts\n@@\n-x\n+y").map((c) => c.path),
      ["b.ts"],
    );
    // Models leave blank lines: trailing ones are dropped, inner ones are context.
    const [blank] = actionsOf(
      [
        custom(
          "p3",
          "apply_patch",
          "*** Begin Patch\n*** Update File: e.ts\n@@\n a\n\n-b\n+c\n\n*** End Patch",
        ),
        customOutput("p3", "Exit code: 0\nOutput:\nSuccess.\n"),
      ],
      [],
    ).actions;
    assert.strictEqual(blank?.files?.[0]?.diff, "@@ -1,3 +1,3 @@\n a\n \n-b\n+c");
  });

  it("shows code-mode scripts once: as their command, or through the items they recorded", () => {
    const lines = [
      event({ type: "task_started", turn_id: "turn-1" }),
      custom(
        "x1",
        "exec",
        'const r = await tools.exec_command({"cmd":"ls src","workdir":"/repo"});\ntext(r.output);',
      ),
      customOutput("x1", [
        { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
        { type: "input_text", text: "a.ts\n" },
      ]),
      // Newer Codex records what a script ran as its own items, between the call and its output.
      custom("x2", "exec", 'text(await tools.mcp__docs__search({q: "x"}));'),
      completed("turn-1", { type: "McpToolCall", id: "exec-1" }),
      customOutput("x2", [{ type: "input_text", text: "Script completed\nOutput:\n" }]),
      custom("x3", "exec", 'await tools.update_plan({plan: [{step: "a", status: "pending"}]});'),
      customOutput("x3", "Script completed\nOutput:\n"),
      custom("x4", "exec", "text(1 + 1);"),
      customOutput("x4", "Script running with cell ID 7\nOutput:\n"),
      call("x5", "wait", { cell_id: "7" }),
      output("x5", [{ type: "input_text", text: "Script failed\nOutput:\nboom" }]),
      event({ type: "task_complete", turn_id: "turn-1" }),
    ];
    const nested = {
      type: "mcpToolCall",
      id: "exec-1",
      server: "docs",
      tool: "search",
      status: "completed",
      arguments: { q: "x" },
      result: { content: [{ type: "text", text: "found" }] },
    };
    const { actions } = actionsOf(lines, [nested]);
    assert.deepStrictEqual(
      actions.map((a) => [a.id, a.kind, a.status, a.title, a.output]),
      [
        ["x1", "search", "unknown", "list src", "a.ts\n"],
        ["exec-1", "tool", "ok", 'docs · search {"q":"x"}', "found"],
        ["x4", "tool", "failed", "script text(1 + 1);", "boom"],
      ],
    );
  });

  it("names web, MCP and subagent calls, without doubling what thread/read has", () => {
    const lines = [
      item({
        type: "web_search_call",
        status: "completed",
        action: { type: "search", query: "effect schema" },
      }),
      item({
        type: "web_search_call",
        status: "completed",
        action: { type: "open_page", url: "https://a.dev" },
      }),
      call("m1", "_fetch_pr", { pr_number: 1 }, { namespace: "mcp__codex_apps__github" }),
      output("m1", 'Wall time: 1 seconds\nOutput:\n{"title":"PR"}'),
      call("m2", "query-docs", { q: "x" }, {}),
      call("m3", "mcp__context7__query-docs", { q: "x" }),
      output("m3", "docs"),
      call(
        "a1",
        "spawn_agent",
        { task_name: "reviewer", message: "gAAAAABencrypted" },
        { namespace: "collaboration" },
      ),
      output("a1", '{"task_name":"/root/reviewer"}'),
      call("a2", "wait_agent", { targets: ["nope"] }),
      output("a2", "invalid agent id nope"),
      call("c1", "exec_command", { cmd: "ls" }),
      output("c1", "Process exited with code 0\nOutput:\n"),
      call("u1", "update_plan", { plan: [] }),
      output("u1", "Plan updated"),
    ];
    const known = [
      {
        type: "webSearch",
        id: "ws_1",
        query: "effect schema",
        action: { type: "search", query: "effect schema" },
      },
      { type: "commandExecution", id: "c1", status: "completed", command: "ls", exitCode: 0 },
    ];
    const { actions } = actionsOf(lines, known);
    assert.deepStrictEqual(
      actions.map((a) => [a.kind, a.status, a.title]),
      [
        ["web", "ok", 'web search "effect schema"'],
        ["web", "ok", "fetch https://a.dev"],
        ["tool", "ok", 'github · fetch_pr {"pr_number":1}'],
        ["tool", "failed", 'query-docs {"q":"x"}'],
        ["tool", "ok", 'context7 · query-docs {"q":"x"}'],
        ["agent", "ok", "subagent spawn_agent: reviewer"],
        ["agent", "failed", "subagent wait_agent"],
        ["search", "ok", "list ."],
      ],
    );
  });

  it("names image generation and image views", () => {
    const lines = [
      custom("v1", "exec", 'image((await tools.view_image({path:"/repo/shot.png"})).image_url);'),
      customOutput("v1", [{ type: "input_text", text: "Script completed\nOutput:\n" }]),
    ];
    const generated = {
      type: "imageGeneration",
      id: "exec-2",
      status: "completed",
      revisedPrompt: "Use case: social card\nA warm editorial card",
    };
    const { actions } = actionsOf(lines, [generated]);
    assert.deepStrictEqual(
      actions.map((a) => [a.kind, a.title]),
      [
        ["tool", "generate image: Use case: social card"],
        ["read", "view image shot.png"],
      ],
    );
  });

  it("marks a call cut off by an interrupted turn as failed, not running", () => {
    const lines = [
      event({ type: "task_started", turn_id: "turn-1" }),
      call("c1", "exec_command", { cmd: "sleep 100" }),
    ];
    assert.strictEqual(actionsOf(lines, [], "interrupted").actions[0]?.status, "failed");
    assert.strictEqual(actionsOf(lines, [], "inProgress").actions[0]?.status, "running");
  });

  it("quotes argv like Codex (shlex)", () => {
    assert.strictEqual(shellJoin(["ls", "-la", ""]), "ls -la ''");
    assert.strictEqual(shellJoin(["sh", "-c", "echo 'hi'"]), `sh -c "echo 'hi'"`);
    assert.strictEqual(shellJoin(["sh", "-c", "echo $HOME 'x'"]), `sh -c 'echo $HOME '"'x'"`);
    assert.strictEqual(shellJoin(["printf", 'a\\tb "c"']), `printf "a\\\\tb \\"c\\""`);
  });
  it("keeps separate web actions that share a query or URL", () => {
    second = 0;
    const search = (query: string) =>
      item({ type: "web_search_call", status: "completed", action: { type: "search", query } });
    const lines = [
      search("effect schema"),
      completed("turn-1", { type: "WebSearch", id: "ws1" }),
      item({
        type: "web_search_call",
        status: "completed",
        action: { type: "open_page", url: "https://a.dev" },
      }),
      completed("turn-1", { type: "WebSearch", id: "ws2" }),
      item({
        type: "web_search_call",
        status: "completed",
        action: { type: "find_in_page", url: "https://a.dev", pattern: "Schema" },
      }),
      event({ type: "token_count" }),
      event({ type: "token_count" }),
      event({ type: "token_count" }),
      event({ type: "token_count" }),
      event({ type: "token_count" }),
      event({ type: "token_count" }),
      search("effect schema"),
    ];
    const known = [
      {
        type: "webSearch",
        id: "ws1",
        query: "effect schema",
        action: { type: "search", query: "effect schema" },
      },
      {
        type: "webSearch",
        id: "ws2",
        query: "https://a.dev",
        action: { type: "openPage", url: "https://a.dev" },
      },
    ];
    assert.deepStrictEqual(
      actionsOf(lines, known).actions.map((a) => [
        a.id.startsWith("ws") ? a.id : "rollout",
        a.title,
      ]),
      [
        ["ws1", 'web search "effect schema"'],
        ["ws2", "fetch https://a.dev"],
        ["rollout", "fetch https://a.dev"],
        ["rollout", 'web search "effect schema"'],
      ],
    );
    // Newer Codex completes the item just before its call; each call still pairs with one item.
    const before = [
      completed("turn-1", { type: "WebSearch", id: "ws3" }),
      search("x"),
      completed("turn-1", { type: "WebSearch", id: "ws4" }),
      search("x"),
    ];
    const x = (id: string) => ({
      type: "webSearch",
      id,
      query: "x",
      action: { type: "search", query: "x" },
    });
    assert.deepStrictEqual(
      actionsOf(before, [x("ws3"), x("ws4")]).actions.map((a) => a.id),
      ["ws3", "ws4"],
    );
  });

  it("keeps a script command's exit code, and marks it unknown when the script dropped it", () => {
    const lines = [
      custom("s1", "exec", 'text(await tools.exec_command({cmd: "pnpm test"}));'),
      customOutput("s1", 'Script completed\nOutput:\n{"exit_code":1,"output":"1 test failed"}'),
      custom(
        "s2",
        "exec",
        'const r = await tools.exec_command({cmd: "pnpm lint"});\ntext(r.output);',
      ),
      customOutput("s2", "Script completed\nOutput:\nall clean\n"),
    ];
    assert.deepStrictEqual(
      actionsOf(lines, []).actions.map((a) => [a.kind, a.status, a.title, a.exitCode, a.output]),
      [
        ["test", "failed", "pnpm test", 1, "1 test failed"],
        ["build", "unknown", "pnpm lint", undefined, "all clean\n"],
      ],
    );
  });

  it("keeps a command running until it finishes, and fails it if the turn ends first", () => {
    const lines = [
      event({ type: "task_started", turn_id: "turn-1" }),
      call("c1", "exec_command", { cmd: "pnpm build" }),
      output("c1", "Process running with session ID 41\nOutput:\nbuilding\n"),
    ];
    assert.deepStrictEqual(
      actionsOf(lines, [], "inProgress").actions.map((a) => [a.status, a.output]),
      [["running", "building\n"]],
    );
    assert.strictEqual(actionsOf(lines, [], "interrupted").actions[0]?.status, "failed");
    const finished = [
      ...lines,
      call("c2", "write_stdin", { session_id: 41, chars: "" }),
      output("c2", "Process exited with code 0\nOutput:\ndone\n"),
    ];
    assert.strictEqual(actionsOf(finished, [], "inProgress").actions[0]?.status, "ok");
  });
});
