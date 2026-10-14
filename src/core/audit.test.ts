import { assert, describe, it } from "@effect/vitest";

import { auditLines, auditSessions } from "./audit.ts";
import type { Action } from "./domain.ts";

const action = (extra: Partial<Action>): Action => ({
  type: "action",
  id: "a",
  at: "2026-01-01T00:00:00Z",
  kind: "run",
  status: "ok",
  title: "x",
  ...extra,
});
const file = (exactLines?: boolean) => ({
  path: "a.ts",
  added: 1,
  removed: 0,
  isNew: false,
  isDeleted: false,
  ...(exactLines ? { exactLines } : {}),
});

describe("auditSessions", () => {
  it("counts what each provider recorded, never the values", () => {
    const audit = auditSessions([
      {
        provider: "codex",
        subagent: false,
        snapshot: { startCommit: "a".repeat(40), model: "secret-model" },
        entries: [
          action({ command: "vp test", exitCode: 0 }),
          action({ kind: "edit", files: [file(true)] }),
        ],
      },
      {
        provider: "claudeAgent",
        subagent: true,
        snapshot: { model: "m" },
        entries: [action({ command: "ls" }), action({ kind: "edit", files: [file()] })],
      },
    ]);
    assert.deepStrictEqual(
      audit.map((p) => [p.provider, p.sessions, p.subagents, p.fields.startCommit, p.fields.model]),
      [
        ["claudeAgent", 1, 1, 0, 1],
        ["codex", 1, 0, 1, 1],
      ],
    );
    assert.deepStrictEqual(
      audit.map((p) => [p.commands, p.withExitCode, p.edits, p.exactEdits]),
      [
        [1, 0, 1, 0],
        [1, 1, 1, 1],
      ],
    );
    const lines = auditLines(audit, 2);
    assert.include(lines, "  commands with an exit code: 1/1");
    assert.include(lines, "! 2 sessions couldn't be read");
    assert.notInclude(lines.join("\n"), "secret-model");
  });
});
