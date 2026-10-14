import { assert, describe, it } from "@effect/vitest";

import { checksFor } from "./checks.ts";
import type { Action, Entry } from "./domain.ts";

const prompt = (id: string, at: string): Entry => ({
  type: "message",
  id,
  at,
  role: "user",
  text: "go",
});
const act = (id: string, at: string, extra: Partial<Action>): Entry => ({
  type: "action",
  id,
  at,
  kind: "run",
  status: "ok",
  title: id,
  ...extra,
});
const edit = (id: string, at: string, lines: string[]) =>
  act(id, at, {
    kind: "edit",
    files: [
      {
        path: "a.ts",
        added: lines.length,
        removed: 0,
        isNew: false,
        isDeleted: false,
        diff: `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`,
      },
    ],
  });

const STORE = "export function saveThread(record) {";
const RETRY = "export const retries = maxRetries ?? 3;";
const OTHER = "export const unrelatedHelper = () => 42;";

describe("checksFor", () => {
  const entries: Entry[] = [
    prompt("u0", "2026-01-01T09:00:00Z"),
    act("t0", "2026-01-01T09:01:00Z", { kind: "test", command: "vp test", exitCode: 0 }),
    prompt("u1", "2026-01-01T10:00:00Z"),
    edit("e1", "2026-01-01T10:01:00Z", [STORE]),
    act("t1", "2026-01-01T10:02:00Z", { kind: "test", command: "vp test", exitCode: 0 }),
    edit("e2", "2026-01-01T10:03:00Z", [RETRY]),
    edit("e3", "2026-01-01T10:04:00Z", [OTHER]),
    act("t2", "2026-01-01T10:05:00Z", { kind: "test", status: "failed" }),
    prompt("u2", "2026-01-01T10:10:00Z"),
    // A later test-only turn still counts for the commit.
    act("t3", "2026-01-01T10:11:00Z", { kind: "build", command: "vp check || true" }),
    act("t4", "2026-01-01T10:12:00Z", { kind: "test", status: "running" }),
    // After the commit: not something it rested on.
    act("t5", "2026-01-01T12:00:00Z", { kind: "test", exitCode: 0 }),
  ];
  const checks = checksFor({
    entries,
    turns: ["u1"],
    novel: [STORE, RETRY],
    committedAt: "2026-01-01T11:00:00Z",
  });

  it("starts at the first linked turn and stops at the commit", () => {
    assert.deepStrictEqual(
      checks.map((c) => [c.actionId, c.turn]),
      [
        ["t1", "u1"],
        ["t2", "u1"],
        ["t3", "u2"],
        ["t4", "u2"],
      ],
    );
  });

  it("names what each outcome rests on, and a check that can't fail is unknown", () => {
    assert.deepStrictEqual(
      checks.map((c) => [c.outcome, c.basis, c.masked ?? false]),
      [
        ["passed", "exit code", false],
        ["failed", "error flag", false],
        ["unknown", "error flag", true],
        ["interrupted", "none", false],
      ],
    );
  });

  it("counts the commit's lines written after a check, and only those", () => {
    // t1 ran before RETRY was written; the unrelated edit doesn't count against anything.
    assert.deepStrictEqual(
      checks.map((c) => c.linesAfter),
      [1, 0, 0, 0],
    );
  });

  it("finds nothing when no linked turn is in the session", () => {
    assert.deepStrictEqual(
      checksFor({ entries, turns: ["nope"], novel: [STORE], committedAt: "2026-01-02T00:00:00Z" }),
      [],
    );
  });
});
