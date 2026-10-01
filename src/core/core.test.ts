import { assert, describe, it } from "@effect/vitest";

import type { Action } from "./domain.ts";
import { clipDiff, normalize, type ActivityRow } from "./normalize.ts";
import type { ToolPayload } from "./payload.ts";
import { classifyRun, humanizeCommand } from "./shell.ts";
import { buildTree, DEFAULT_SWITCHES } from "./tree.ts";

describe("core", () => {
  const titles = (cmd: string) => humanizeCommand(cmd).map((p) => `${p.kind}:${p.title}`);

  it("humanizes wrapped, chained and piped commands", () => {
    assert.deepStrictEqual(
      titles(
        `/bin/zsh -lc "sed -n '1,260p' apps/server/src/ws.ts && rg -n \\"createThread|bootstrap\\" apps/server/src | head -120"`,
      ),
      [
        "read:read apps/server/src/ws.ts:1-260",
        'search:search "createThread|bootstrap" in apps/server/src',
      ],
    );
    assert.deepStrictEqual(titles("cd /repo && ./node_modules/.bin/vp run --filter t3 typecheck"), [
      "build:vp run --filter t3 typecheck",
    ]);
    assert.deepStrictEqual(titles("git status --short && git push -u origin HEAD"), [
      "read:git status --short",
      "git:git push -u origin HEAD",
    ]);
    assert.deepStrictEqual(titles("gh pr view 12 --json title"), [
      "read:gh pr view 12 --json title",
    ]);
    assert.strictEqual(humanizeCommand("gh pr create --title x")[0]?.kind, "git");
    assert.deepStrictEqual(titles("cat > notes.md <<'EOF'\nhello && world\nEOF\ncat notes.md"), [
      "edit:write notes.md",
      "read:read notes.md",
    ]);
    assert.deepStrictEqual(titles("rg --files apps/web | rg Timeline"), ["search:list apps/web"]);
    assert.deepStrictEqual(titles("head -n 40 a.ts 2>/dev/null"), ["read:read a.ts"]);
  });

  it("classifies commands by intent, whatever the toolchain", () => {
    const cases: Array<[string, string]> = [
      ["go test ./... -run X", "test"],
      ["vp test run src", "test"],
      ["cargo test --locked", "test"],
      ["bun test --timeout 60000 a.test.ts", "test"],
      ["pnpm --filter t3 test", "test"],
      ["npm run test:integration", "test"],
      ["uv run pytest -x", "test"],
      ["python3 -m pytest tests", "test"],
      ["npx vitest run", "test"],
      ["node --test core/", "test"],
      ["vp build", "build"],
      ["go build ./cmd/server", "build"],
      ["cargo build --release", "build"],
      ["vp run --filter t3 typecheck", "build"],
      ["tsc --noEmit", "build"],
      ["pnpm install --frozen-lockfile", "setup"],
      ["vp i", "setup"],
      ["uv pip install -r requirements.txt", "setup"],
      ["go mod download", "setup"],
      ["brew install ripgrep", "setup"],
      ["pnpm dev", "run"],
      ["go run ./cmd/server", "run"],
      ["python3 scripts/report.py", "run"],
      ["make -C infra deploy-preview ENV=staging", "run"],
      ["docker compose -p x run --rm tests bun test", "docker"],
    ];
    for (const [cmd, kind] of cases) assert.strictEqual(classifyRun(cmd.split(" ")), kind, cmd);
  });

  it("clips long diffs at hunk boundaries", () => {
    const hunk = (n: number) => `@@ -${n},1 +${n},1 @@\n-${"a".repeat(5000)}\n+${"b".repeat(5000)}`;
    const { diff, truncated } = clipDiff([hunk(1), hunk(10), hunk(20)].join("\n"));
    assert.strictEqual(truncated, true);
    assert.deepStrictEqual(diff.match(/^@@ /gm)?.length, 1);
    assert.deepStrictEqual(clipDiff("@@ -1,1 +1,1 @@\n-a\n+b"), {
      diff: "@@ -1,1 +1,1 @@\n-a\n+b",
    });
    // One oversized new-file hunk is cut by lines, with header counts that match what's left.
    const big = clipDiff(
      ["@@ -0,0 +1,3000 @@", ...Array.from({ length: 3000 }, (_, i) => `+line ${i}`)].join("\n"),
    );
    const lines = big.diff.split("\n");
    assert.strictEqual(big.truncated, true);
    assert.strictEqual(lines[0], `@@ -0,0 +1,${lines.length - 1} @@`);
  });

  const row = (
    id: string,
    at: string,
    payload: ToolPayload,
    kind = "tool.completed",
  ): ActivityRow => ({ id, at, kind, tone: "tool", summary: "", payload });

  it("normalizes codex, claude and cursor payloads", () => {
    const entries = normalize(
      [
        row(
          "a0",
          "2026-01-01T00:00:00Z",
          {
            itemType: "command_execution",
            toolCallId: "c1",
            status: "inProgress",
            data: { item: { command: "/bin/zsh -lc 'bun install'" } },
          },
          "tool.started",
        ),
        row("a1", "2026-01-01T00:00:05Z", {
          itemType: "command_execution",
          toolCallId: "c1",
          status: "completed",
          data: {
            item: {
              command: "/bin/zsh -lc 'bun install'",
              exitCode: 1,
              aggregatedOutput: "error: lockfile is frozen",
            },
          },
        }),
        row("a2", "2026-01-01T00:00:06Z", {
          itemType: "command_execution",
          toolCallId: "c2",
          status: "completed",
          data: {
            item: {
              command: "rg -n nothing src",
              exitCode: 1,
              commandActions: [{ type: "search" }],
            },
          },
        }),
        row("a3", "2026-01-01T00:00:07Z", {
          itemType: "file_change",
          toolCallId: "c3",
          status: "completed",
          data: {
            item: {
              changes: [
                {
                  path: "/repo/src/a.ts",
                  kind: { type: "update" },
                  diff: "@@ -1,2 +1,2 @@\n-old\n+new\n+more",
                },
                { path: "/repo/src/b.ts", kind: { type: "add" }, diff: "line1\nline2" },
              ],
            },
          },
        }),
        row("a4", "2026-01-01T00:00:08Z", {
          itemType: "command_execution",
          toolCallId: "t1",
          status: "failed",
          data: {
            toolName: "Bash",
            input: { command: "pnpm test", description: "Run tests" },
            result: { content: "Exit code 2\nFAIL", is_error: true },
          },
        }),
        row("a5", "2026-01-01T00:00:09Z", {
          itemType: "file_change",
          toolCallId: "t2",
          status: "completed",
          data: {
            toolName: "Edit",
            input: { file_path: "/repo/src/c.ts", old_string: "a\nb", new_string: "a\nc\nd" },
            result: { content: "updated" },
          },
        }),
        row("a6", "2026-01-01T00:00:10Z", {
          itemType: "mcp_tool_call",
          toolCallId: "t3",
          status: "completed",
          data: { toolName: "mcp__t3-code__link_pull_request", input: { url: "u" } },
        }),
        row("a8", "2026-01-01T00:00:12Z", {
          itemType: "command_execution",
          toolCallId: "c8",
          status: "completed",
          data: { item: { command: "ls /does-not-exist", exitCode: 1 } },
        }),
        row("a7", "2026-01-01T00:00:11Z", {
          itemType: "file_change",
          data: {
            toolCallId: "x1",
            kind: "edit",
            content: [{ type: "diff", path: "/repo/d.md", oldText: null, newText: "x\ny" }],
          },
        }),
      ],
      [{ id: "m1", at: "2026-01-01T00:00:00Z", role: "user", text: "do it" }],
      { root: "/repo" },
    );
    const actions = entries.filter((e): e is Action => e.type === "action");
    assert.strictEqual(actions.length, 8, "lifecycle rows are merged per tool call");
    const [install, search, edit, test_, claudeEdit, mcp, cursor, failedLs] = actions;
    // exit 1 means "no match" only for rg/grep; a failed ls is a failure.
    assert.deepStrictEqual([failedLs?.status, failedLs?.noMatch], ["failed", undefined]);
    assert.deepStrictEqual(
      [install?.status, install?.exitCode, install?.at],
      ["failed", 1, "2026-01-01T00:00:00Z"],
    );
    assert.deepStrictEqual([search?.kind, search?.status, search?.noMatch], ["search", "ok", true]);
    assert.deepStrictEqual(
      edit?.files?.map((f) => [f.path, f.added, f.removed, f.isNew]),
      [
        ["src/a.ts", 2, 1, false],
        ["src/b.ts", 2, 0, true],
      ],
    );
    assert.deepStrictEqual(
      [test_?.status, test_?.exitCode, test_?.hint],
      ["failed", 2, "Run tests"],
    );
    assert.deepStrictEqual(
      claudeEdit?.files?.map((f) => [f.path, f.added, f.removed]),
      [["src/c.ts", 2, 1]],
    );
    // Diffs are valid unified hunks: Codex new files become one "+" hunk, Claude edits get real headers.
    assert.strictEqual(edit?.files?.[1]?.diff, "@@ -0,0 +1,2 @@\n+line1\n+line2");
    assert.strictEqual(edit?.files?.[0]?.exactLines, true);
    assert.strictEqual(claudeEdit?.files?.[0]?.diff, "@@ -2,1 +2,2 @@\n-b\n+c\n+d");
    assert.strictEqual(claudeEdit?.files?.[0]?.exactLines, undefined);
    assert.strictEqual(mcp?.title, 't3-code · link_pull_request {"url":"u"}');
    assert.deepStrictEqual(
      cursor?.files?.map((f) => [f.path, f.isNew, f.added]),
      [["d.md", true, 2]],
    );
    assert.strictEqual(entries[0]?.type, "message");
  });

  it("builds phases, folds reads and filters", () => {
    const a = (id: string, kind: Action["kind"], status: Action["status"] = "ok"): Action => ({
      type: "action",
      id,
      at: `2026-01-01T00:00:${id.padStart(2, "0")}Z`,
      kind,
      status,
      title: id,
      targets: [`src/${id}.ts`],
    });
    const entries = [
      { type: "message", id: "u", at: "2026-01-01T00:00:00Z", role: "user", text: "go" } as const,
      a("1", "read"),
      a("2", "search"),
      a("3", "read"),
      a("4", "edit"),
      a("5", "run", "failed"),
      a("6", "edit"),
      a("7", "run"),
      a("8", "git"),
    ];
    const [turn] = buildTree(entries, DEFAULT_SWITCHES);
    assert.deepStrictEqual(
      turn?.phases.map((p) => p.name),
      ["explore", "edit", "verify", "fix", "verify", "ship"],
    );
    const fold = turn?.phases[0]?.items[0];
    assert.strictEqual(fold?.type === "fold" && fold.summary, "2 reads · 1 search");
    assert.strictEqual(turn?.stats.failed, 1);

    const [failures] = buildTree(entries, { ...DEFAULT_SWITCHES, failuresOnly: true });
    assert.deepStrictEqual(
      failures?.phases.flatMap((p) => p.items.map((i) => i.id)),
      ["5"],
    );

    const [flat] = buildTree(entries, {
      ...DEFAULT_SWITCHES,
      phases: false,
      foldReads: false,
      kinds: { ...DEFAULT_SWITCHES.kinds, read: false },
    });
    assert.deepStrictEqual(
      flat?.phases.map((p) => p.items.map((i) => i.id)),
      [["2", "4", "5", "6", "7", "8"]],
    );
  });
});
