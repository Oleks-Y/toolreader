import assert from "node:assert/strict";
import { test } from "node:test";
import { normalize, type ActivityRow } from "./normalize.ts";
import { humanizeCommand } from "./shell.ts";
import { buildTree, DEFAULT_SWITCHES } from "./tree.ts";
import type { Action } from "./types.ts";

const titles = (cmd: string) => humanizeCommand(cmd).map((p) => `${p.kind}:${p.title}`);

test("humanizes wrapped, chained and piped commands", () => {
  assert.deepEqual(titles(`/bin/zsh -lc "sed -n '1,260p' apps/server/src/ws.ts && rg -n \\"createThread|bootstrap\\" apps/server/src | head -120"`), [
    "read:read apps/server/src/ws.ts:1-260",
    'search:search "createThread|bootstrap" in apps/server/src',
  ]);
  assert.deepEqual(titles("cd /repo && ./node_modules/.bin/vp run --filter t3 typecheck"), ["run:vp run --filter t3 typecheck"]);
  assert.deepEqual(titles("git status --short && git push -u origin HEAD"), ["read:git status --short", "git:git push -u origin HEAD"]);
  assert.deepEqual(titles("gh pr view 12 --json title"), ["read:gh pr view 12 --json title"]);
  assert.equal(humanizeCommand("gh pr create --title x")[0]?.kind, "git");
  assert.deepEqual(titles("cat > notes.md <<'EOF'\nhello && world\nEOF\ncat notes.md"), ["edit:write notes.md", "read:read notes.md"]);
  assert.deepEqual(titles("rg --files apps/web | rg Timeline"), ["search:list apps/web"]);
  assert.deepEqual(titles("head -n 40 a.ts 2>/dev/null"), ["read:read a.ts"]);
});

const row = (id: string, at: string, payload: unknown, kind = "tool.completed"): ActivityRow => ({ id, at, kind, tone: "tool", summary: "", payload });

test("normalizes codex, claude and cursor payloads", () => {
  const entries = normalize(
    [
      row("a0", "2026-01-01T00:00:00Z", { itemType: "command_execution", toolCallId: "c1", status: "inProgress", data: { item: { command: "/bin/zsh -lc 'bun install'" } } }, "tool.started"),
      row("a1", "2026-01-01T00:00:05Z", { itemType: "command_execution", toolCallId: "c1", status: "completed", data: { item: { command: "/bin/zsh -lc 'bun install'", exitCode: 1, aggregatedOutput: "error: lockfile is frozen" } } }),
      row("a2", "2026-01-01T00:00:06Z", { itemType: "command_execution", toolCallId: "c2", status: "completed", data: { item: { command: "rg -n nothing src", exitCode: 1, commandActions: [{ type: "search" }] } } }),
      row("a3", "2026-01-01T00:00:07Z", { itemType: "file_change", toolCallId: "c3", status: "completed", data: { item: { changes: [
        { path: "/repo/src/a.ts", kind: { type: "update" }, diff: "@@ -1,2 +1,2 @@\n-old\n+new\n+more" },
        { path: "/repo/src/b.ts", kind: { type: "add" }, diff: "line1\nline2" },
      ] } } }),
      row("a4", "2026-01-01T00:00:08Z", { itemType: "command_execution", toolCallId: "t1", status: "failed", data: { toolName: "Bash", input: { command: "pnpm test", description: "Run tests" }, result: { content: "Exit code 2\nFAIL", is_error: true } } }),
      row("a5", "2026-01-01T00:00:09Z", { itemType: "file_change", toolCallId: "t2", status: "completed", data: { toolName: "Edit", input: { file_path: "/repo/src/c.ts", old_string: "a\nb", new_string: "a\nc\nd" }, result: { content: "updated" } } }),
      row("a6", "2026-01-01T00:00:10Z", { itemType: "mcp_tool_call", toolCallId: "t3", status: "completed", data: { toolName: "mcp__t3-code__link_pull_request", input: { url: "u" } } }),
      row("a7", "2026-01-01T00:00:11Z", { itemType: "file_change", data: { toolCallId: "x1", kind: "edit", content: [{ type: "diff", path: "/repo/d.md", oldText: null, newText: "x\ny" }] } }),
    ],
    [{ id: "m1", at: "2026-01-01T00:00:00Z", role: "user", text: "do it" }],
    { root: "/repo" },
  );
  const actions = entries.filter((e): e is Action => e.type === "action");
  assert.equal(actions.length, 7, "lifecycle rows are merged per tool call");
  const [install, search, edit, test_, claudeEdit, mcp, cursor] = actions;
  assert.deepEqual([install?.status, install?.exitCode, install?.at], ["failed", 1, "2026-01-01T00:00:00Z"]);
  assert.deepEqual([search?.kind, search?.status, search?.noMatch], ["search", "ok", true]);
  assert.deepEqual(edit?.files?.map((f) => [f.path, f.added, f.removed, f.isNew]), [["src/a.ts", 2, 1, false], ["src/b.ts", 2, 0, true]]);
  assert.deepEqual([test_?.status, test_?.exitCode, test_?.hint], ["failed", 2, "Run tests"]);
  assert.deepEqual(claudeEdit?.files?.map((f) => [f.path, f.added, f.removed]), [["src/c.ts", 2, 1]]);
  assert.equal(mcp?.title, 't3-code · link_pull_request {"url":"u"}');
  assert.deepEqual(cursor?.files?.map((f) => [f.path, f.isNew, f.added]), [["d.md", true, 2]]);
  assert.equal(entries[0]?.type, "message");
});

test("builds phases, folds reads and filters", () => {
  const a = (id: string, kind: Action["kind"], status: Action["status"] = "ok"): Action => ({ type: "action", id, at: `2026-01-01T00:00:${id.padStart(2, "0")}Z`, kind, status, title: id, targets: [`src/${id}.ts`] });
  const entries = [
    { type: "message", id: "u", at: "2026-01-01T00:00:00Z", role: "user", text: "go" } as const,
    a("1", "read"), a("2", "search"), a("3", "read"),
    a("4", "edit"), a("5", "run", "failed"), a("6", "edit"), a("7", "run"), a("8", "git"),
  ];
  const [turn] = buildTree(entries, DEFAULT_SWITCHES);
  assert.deepEqual(turn?.phases.map((p) => p.name), ["explore", "edit", "verify", "fix", "verify", "ship"]);
  const fold = turn?.phases[0]?.items[0];
  assert.equal(fold?.type === "fold" && fold.summary, "2 reads · 1 search");
  assert.equal(turn?.stats.failed, 1);

  const [failures] = buildTree(entries, { ...DEFAULT_SWITCHES, failuresOnly: true });
  assert.deepEqual(failures?.phases.flatMap((p) => p.items.map((i) => i.id)), ["5"]);

  const [flat] = buildTree(entries, { ...DEFAULT_SWITCHES, phases: false, foldReads: false, kinds: { ...DEFAULT_SWITCHES.kinds, read: false } });
  assert.deepEqual(flat?.phases.map((p) => p.items.map((i) => i.id)), [["2", "4", "5", "6", "7", "8"]]);
});
