import { assert, describe, it } from "@effect/vitest";

import { checksFor, checksForEvidence } from "./checks.ts";
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

  it("takes a link's named entries whenever they ran, and a tested link's turns past the commit", () => {
    const input = {
      entries,
      turns: ["u1"],
      novel: [STORE, RETRY],
      committedAt: "2026-01-01T11:00:00Z",
    };
    // Named entries: those, the one after the commit included.
    assert.deepStrictEqual(
      checksForEvidence({ ...input, turns: [], entryIds: ["t5", "t1"], role: "tested" }).map(
        (c) => c.actionId,
      ),
      ["t1", "t5"],
    );
    // A tested link by turns: those turns' checks, whenever they ran.
    assert.deepStrictEqual(
      checksForEvidence({ ...input, turns: ["u2"], role: "tested" }).map((c) => c.actionId),
      ["t3", "t4", "t5"],
    );
    // An implemented link: as checksFor, cut off at the commit.
    assert.deepStrictEqual(checksForEvidence(input), checks);
  });

  it("finds nothing when no linked turn is in the session", () => {
    assert.deepStrictEqual(
      checksFor({ entries, turns: ["nope"], novel: [STORE], committedAt: "2026-01-02T00:00:00Z" }),
      [],
    );
  });
});

describe("checksFor: what a check ran on, and whether it holds for the commit", () => {
  const SHA = "abcdef1234567890abcdef1234567890abcdef12";
  const BASE = "1111111111111111111111111111111111111111";
  const gitOut = (id: string, at: string, output: string) =>
    act(id, at, { kind: "git", command: "git x", output, exitCode: 0 });
  const test = (id: string, at: string, command = "vitest run") =>
    act(id, at, { kind: "test", command, exitCode: 0 });
  const run = (entries: Entry[], extra: { base?: string; others?: number[] } = {}) =>
    checksFor({
      entries: [prompt("u1", "2026-01-01T10:00:00Z"), ...entries],
      turns: ["u1"],
      novel: [STORE, RETRY],
      committedAt: "2026-01-01T11:00:00Z",
      sha: SHA,
      ...extra,
    });
  const axes = (c: ReturnType<typeof run>) =>
    c.map((k) => [k.actionId, k.testedState, k.applicability]);

  it("ran on the commit itself: the session committed it and changed nothing since", () => {
    const checks = run([
      edit("e1", "2026-01-01T10:01:00Z", [STORE, RETRY]),
      gitOut("g1", "2026-01-01T10:02:00Z", "[main abcdef1] feat: store\n 1 file changed"),
      test("t1", "2026-01-01T10:03:00Z"),
    ]);
    assert.deepStrictEqual(axes(checks), [["t1", "exact reconstructed", "same state"]]);
    assert.strictEqual(checks[0]!.method, "checks/2");
  });

  it("a rebase to another commit isn't claimed equivalent: it's unknown", () => {
    const checks = run([
      edit("e1", "2026-01-01T10:01:00Z", [STORE, RETRY]),
      gitOut("g1", "2026-01-01T10:02:00Z", "[main 9999999] feat: store"),
      test("t1", "2026-01-01T10:03:00Z"),
    ]);
    assert.deepStrictEqual(axes(checks), [["t1", "exact reconstructed", "unknown"]]);
  });

  it("another session writing the commit's lines meanwhile makes it a candidate", () => {
    const checks = run(
      [
        edit("e1", "2026-01-01T10:01:00Z", [STORE, RETRY]),
        gitOut("g1", "2026-01-01T10:02:00Z", "[main abcdef1] feat: store"),
        test("t1", "2026-01-01T10:03:00Z"),
      ],
      { others: [Date.parse("2026-01-01T10:02:30Z")] },
    );
    assert.deepStrictEqual(axes(checks), [["t1", "candidate", "unknown"]]);
    assert.include(checks[0]!.reasons[0]!, "another session");
  });

  it("a known start, a tree shown clean and only exact edits is reconstructed", () => {
    const exact = act("e1", "2026-01-01T10:02:00Z", {
      kind: "edit",
      files: [
        { path: "a.ts", added: 1, removed: 0, isNew: false, isDeleted: false, exactLines: true },
      ],
    });
    const clean = gitOut(
      "g0",
      "2026-01-01T10:01:00Z",
      "On branch main\nnothing to commit, working tree clean",
    );
    assert.deepStrictEqual(
      axes(run([clean, exact, test("t1", "2026-01-01T10:03:00Z")], { base: BASE })),
      [["t1", "exact reconstructed", "unknown"]],
    );
    // A dirty tree (never shown clean): only a candidate.
    assert.deepStrictEqual(axes(run([exact, test("t1", "2026-01-01T10:03:00Z")], { base: BASE })), [
      ["t1", "candidate", "unknown"],
    ]);
    // A shell command could have changed anything: a candidate too.
    const shell = act("r1", "2026-01-01T10:02:30Z", { kind: "run", command: "sed -i s/a/b/ a.ts" });
    assert.deepStrictEqual(
      axes(run([clean, exact, shell, test("t1", "2026-01-01T10:03:00Z")], { base: BASE })),
      [["t1", "candidate", "unknown"]],
    );
    // No start recorded: unknown.
    assert.deepStrictEqual(axes(run([test("t1", "2026-01-01T10:03:00Z")])), [
      ["t1", "unknown", "unknown"],
    ]);
  });

  it("stale only on evidence: a later edit to a file it named, or a changed lockfile", () => {
    const later = (path: string) =>
      act("e2", "2026-01-01T10:04:00Z", {
        kind: "edit",
        files: [
          {
            path,
            added: 1,
            removed: 0,
            isNew: false,
            isDeleted: false,
            diff: `@@ -0,0 +1 @@\n+${RETRY}`,
          },
        ],
      });
    const named = run([
      test("t1", "2026-01-01T10:03:00Z", "vitest run src/retry.ts"),
      later("/repo/src/retry.ts"),
    ]);
    assert.deepStrictEqual(axes(named), [["t1", "unknown", "definitely stale"]]);
    assert.deepStrictEqual(named[0]!.scope, ["src/retry.ts"]);
    // The same line into a file it didn't name: written after it, but not proof.
    const elsewhere = run([
      test("t1", "2026-01-01T10:03:00Z", "vitest run src/retry.ts"),
      later("/repo/src/other.ts"),
    ]);
    assert.deepStrictEqual(axes(elsewhere), [["t1", "unknown", "unknown"]]);
    assert.include(elsewhere[0]!.reasons[1]!, "outside what it named");
    // An unrelated edit (no line of the commit) changes nothing.
    const unrelated = run([
      test("t1", "2026-01-01T10:03:00Z"),
      edit("e3", "2026-01-01T10:04:00Z", [OTHER]),
    ]);
    assert.deepStrictEqual([unrelated[0]!.applicability, unrelated[0]!.linesAfter], ["unknown", 0]);
    // A lockfile changed after it: stale whatever it named.
    const lock = act("e4", "2026-01-01T10:04:00Z", {
      kind: "edit",
      files: [{ path: "pnpm-lock.yaml", added: 1, removed: 1, isNew: false, isDeleted: false }],
    });
    assert.deepStrictEqual(axes(run([test("t1", "2026-01-01T10:03:00Z"), lock])), [
      ["t1", "unknown", "definitely stale"],
    ]);
  });
});
