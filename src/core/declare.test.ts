import { assert, describe, it } from "@effect/vitest";

import {
  applyDeclarations,
  declarationsIn,
  isGitCommit,
  parseDeclaration,
  parseDeclarations,
  parseTurns,
  turnIds,
} from "./declare.ts";
import type { Action, Entry } from "./domain.ts";
import type { CommitHistory } from "./history.ts";

const SHA = "a".repeat(40);
const at = (minute: number) => `2026-01-01T10:${String(minute).padStart(2, "0")}:00.000Z`;
const prompt = (n: number): Entry => ({
  type: "message",
  id: `u${n}`,
  at: at(n * 2),
  role: "user",
  text: `turn ${n}`,
});
const run = (id: string, minute: number, command: string, output = "", failed = false): Action => ({
  type: "action",
  id,
  at: at(minute),
  kind: "run",
  status: failed ? "failed" : "ok",
  title: command,
  command,
  output,
});

describe("declare", () => {
  it("reads turn lists and ranges", () => {
    assert.deepStrictEqual(parseTurns("3-5,9, 4"), [3, 4, 5, 9]);
    assert.isNull(parseTurns("0-2"));
    assert.isNull(parseTurns("five"));
  });

  it("finds a declaration in any way the CLI is run, with the SHA the command printed", () => {
    assert.deepStrictEqual(
      parseDeclaration(
        `/bin/zsh -lc "npx toolreader history link --sha HEAD --turns 2-3 --note 'wrote the store'"`,
        `history link: ${SHA} for HEAD (T2–T3 of "Add a")\n`,
      ),
      { kind: "link", sha: SHA, turns: [2, 3], session: null, note: "wrote the store" },
    );
    assert.deepStrictEqual(
      parseDeclaration(
        "node /x/dist/bin.mjs history unlink --sha=abc1234 --session codex:t2",
        `history unlink: ${"c".repeat(40)} for abc1234`,
      ),
      { kind: "unlink", sha: "c".repeat(40), turns: null, session: "codex:t2", note: null },
    );
    // Only what ran and confirmed: of `a || b`, the one whose line was printed.
    assert.deepStrictEqual(
      parseDeclarations(
        "(command -v toolreader && toolreader history link --sha HEAD --note x || npx toolreader history link --sha HEAD --note x)",
        `history link: ${SHA} for HEAD (T1)`,
      ).map((d) => [d.sha, d.note]),
      [[SHA, "x"]],
    );
    // Run, but no line (refused, or the record holds no output yet): nothing declared.
    assert.isNull(parseDeclaration("toolreader history link --sha HEAD"));
    // Talking about it, or another program's `history`, declares nothing.
    assert.isNull(parseDeclaration("echo toolreader history link --sha HEAD | grep history"));
    assert.isNull(parseDeclaration("history link --sha abc1234"));
    assert.isNull(parseDeclaration("toolreader history link --turns x --sha abc1234"));
  });

  it("takes the turns since the previous declaration when none are named, and skips failures", () => {
    const entries: Entry[] = [
      prompt(1),
      prompt(2),
      run("c1", 5, "toolreader history link --sha HEAD", `history link: ${SHA} for HEAD`),
      prompt(3),
      run("bad", 7, "toolreader history link --sha nope", "", true),
      prompt(4),
      run(
        "c2",
        9,
        "toolreader history link --sha bbbbbbb",
        `history link: ${"b".repeat(40)} for bbbbbbb`,
      ),
      run(
        "other",
        10,
        "toolreader history link --sha ccccccc --session codex:else --turns 1",
        `history link: ${"c".repeat(40)} for ccccccc`,
      ),
    ];
    assert.deepStrictEqual(
      declarationsIn("t1", entries).map((d) => [d.sha.slice(0, 7), d.turns, d.turn, d.session]),
      [
        ["aaaaaaa", [1, 2], 2, null],
        ["bbbbbbb", [3, 4], 4, null],
        ["ccccccc", [1], 4, "codex:else"],
      ],
    );
    assert.deepStrictEqual(turnIds(entries, [2, 4, 99]), ["u2", "u4"]);
  });

  it("reads every declaration in a chained command, and a second commit in the same turn", () => {
    const b = "b".repeat(40);
    const entries: Entry[] = [
      prompt(1),
      prompt(2),
      run(
        "c1",
        5,
        "toolreader history link --sha HEAD~1 --note one && toolreader history link --sha HEAD --note two",
        `history link: ${SHA} for HEAD~1 (T1–T2)\nhistory link: ${b} for HEAD (T2)\n`,
      ),
    ];
    assert.deepStrictEqual(
      declarationsIn("t1", entries).map((d) => [d.sha, d.note, d.turns]),
      [
        [SHA, "one", [1, 2]],
        [b, "two", [2]],
      ],
    );
  });

  it("recounts the lines its agents wrote when one is unlinked", () => {
    const history: CommitHistory = {
      sha: SHA,
      novel: 10,
      explained: 5,
      links: [
        { threadId: "t1", turns: ["u1"], via: "content", lines: 3 },
        { threadId: "t2", turns: ["v1"], via: "content", lines: 3 },
      ],
      hits: new Map([
        ["t1", new Set(["a", "b", "c"])],
        ["t2", new Set(["c", "d", "e"])],
      ]),
    };
    const out = applyDeclarations(history, [
      { kind: "unlink", sha: SHA, threadId: "t2", turns: [], note: null, by: "t1", at: at(1) },
    ]);
    assert.strictEqual(out.explained, 3);
  });

  it("puts declared links first, replaces what matching found for that thread, and unlinks", () => {
    const history: CommitHistory = {
      sha: SHA,
      novel: 10,
      explained: 6,
      links: [
        { threadId: "t1", turns: ["u9"], via: "content", lines: 4 },
        { threadId: "t2", turns: ["v1"], via: "content", lines: 2 },
        { threadId: "t3", turns: [], via: "trailer", lines: 0 },
      ],
    };
    const base = { sha: SHA, note: null, by: "t1" } as const;
    const out = applyDeclarations(history, [
      { ...base, kind: "unlink", threadId: "t3", turns: [], at: at(2) },
      { ...base, kind: "link", threadId: "t1", turns: ["u1", "u2"], note: "mine", at: at(1) },
      { ...base, kind: "link", threadId: "t4", turns: ["w1"], at: at(3) },
      { ...base, sha: "b".repeat(40), kind: "unlink", threadId: "t2", turns: [], at: at(4) },
    ]);
    assert.deepStrictEqual(out.links, [
      { threadId: "t1", turns: ["u1", "u2"], via: "asserted", lines: 4, note: "mine" },
      { threadId: "t4", turns: ["w1"], via: "asserted", lines: 0, declaredBy: "t1" },
      { threadId: "t2", turns: ["v1"], via: "content", lines: 2 },
    ]);
  });
  it("tells a git commit from other commands", () => {
    for (const yes of [
      'git commit -m "x"',
      "cd repo && git -C sub -c user.name=a commit --amend --no-edit",
      "/bin/zsh -lc 'git add -A && git commit -qm wip'",
    ])
      assert.isTrue(isGitCommit(yes), yes);
    for (const no of [
      "git commit --dry-run",
      "git log --grep commit",
      "echo git commit",
      "git status",
    ])
      assert.isFalse(isGitCommit(no), no);
  });
});
