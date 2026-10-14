import { assert, describe, it } from "@effect/vitest";

import {
  around,
  buildRequest,
  parseLineLink,
  covers,
  hunksOf,
  marksOf,
  piecesOf,
  readBlame,
  type SystemOneResponse,
} from "./blame.ts";
import type { Action, Entry } from "./domain.ts";

const at = (minute: number) => `2026-01-01T10:${String(minute).padStart(2, "0")}:00Z`;
const prompt = (id: string, minute: number): Entry => ({
  type: "message",
  id,
  at: at(minute),
  role: "user",
  text: id,
});
const action = (id: string, minute: number, fields: Partial<Action>): Action => ({
  type: "action",
  id,
  at: at(minute),
  kind: "run",
  status: "ok",
  title: id,
  ...fields,
});

const DIFF = [
  "diff --git a/src/x.ts b/src/x.ts",
  "--- a/src/x.ts",
  "+++ b/src/x.ts",
  "@@ -1,2 +1,2 @@",
  "-const a = 1;",
  "+const a = 2;",
  "@@ -10 +10,2 @@ fn",
  " keep",
  "+added",
  "diff --git a/old.txt b/old.txt",
  "deleted file mode 100644",
  "--- a/old.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-gone",
  "diff --git a/img.png b/img.png",
  "Binary files a/img.png and b/img.png differ",
].join("\n");

describe("blame", () => {
  it("splits a diff into hunks, a deleted file under its old path, binaries without any", () => {
    const hunks = hunksOf(DIFF);
    assert.deepStrictEqual(
      hunks.map((h) => [h.id, h.path, h.header, h.text]),
      [
        ["H1", "src/x.ts", "@@ -1,2 +1,2 @@", "-const a = 1;\n+const a = 2;"],
        ["H2", "src/x.ts", "@@ -10 +10,2 @@ fn", " keep\n+added"],
        ["H3", "old.txt", "@@ -1 +0,0 @@", "-gone"],
      ],
    );
  });

  it("finds the hunk holding a line of the file as the commit has it", () => {
    const [h1, h2, h3] = hunksOf(DIFF);
    assert.isTrue(covers(h1!, "src/x.ts", 2));
    assert.isFalse(covers(h1!, "src/x.ts", 3));
    assert.isTrue(covers(h2!, "src/x.ts", 11));
    assert.isFalse(covers(h2!, "other.ts", 11));
    // Only removed lines: the line they were removed before.
    assert.isTrue(covers(h3!, "old.txt", 0));
  });

  it("cuts a hunk down to the lines around one", () => {
    const text = ["+a", "+b", "+c", "+d", "+e", "+f"].join("\n");
    assert.deepStrictEqual(around({ header: "@@ -0,0 +1,6 @@", text }, 4, 1), {
      header: "@@ -0,0 +3,3 @@",
      text: "+c\n+d\n+e",
    });
    // Removed lines go with the new line they precede.
    assert.deepStrictEqual(around({ header: "@@ -10,3 +10,2 @@", text: " x\n-y\n+z\n w" }, 11, 0), {
      header: "@@ -11,1 +11,1 @@",
      text: "-y\n+z",
    });
  });

  it("takes pieces from the linked turns only, before the commit, leaving out reads", () => {
    const entries: Entry[] = [
      prompt("p1", 0),
      action("install", 1, { kind: "setup", command: "pnpm add effect" }),
      prompt("p2", 2),
      action("look", 3, { kind: "read" }),
      action("script", 4, { command: "python fix.py" }),
      action("late", 30, { command: "sed -i s/a/b/ x" }),
    ];
    const pieces = piecesOf([{ threadId: "t", turns: ["p2"] }], () => entries, at(10));
    assert.deepStrictEqual(
      pieces.map((p) => [p.id, p.action.id]),
      [["A01", "script"]],
    );
    // A link naming no turns (a trailer) takes the whole thread.
    assert.deepStrictEqual(
      piecesOf([{ threadId: "t", turns: [] }], () => entries, at(10)).map((p) => p.action.id),
      ["install", "script"],
    );
  });

  it("asks one Noul per piece and a Choice with none, sending only the hunk file's diff, cleaned", () => {
    const [hunk] = hunksOf(DIFF);
    const edit = action("e", 1, {
      kind: "edit",
      title: "edit /home/me/repo/src/x.ts",
      files: [
        {
          path: "/home/me/repo/src/x.ts",
          added: 1,
          removed: 1,
          isNew: false,
          isDeleted: false,
          diff: "+const a = 2;",
        },
        {
          path: "/home/me/repo/other.ts",
          added: 1,
          removed: 0,
          isNew: false,
          isDeleted: false,
          diff: "+secret other",
        },
      ],
    });
    // Doesn't name x.ts: sent in brief, without its output.
    const install = action("install", 2, {
      kind: "setup",
      command: `pnpm add effect ${"x".repeat(300)}`,
      output: "added 3 packages",
    });
    const request = buildRequest(
      {
        subject: "bump a",
        hunk: hunk!,
        pieces: [
          { id: "A01", threadId: "t", action: edit },
          { id: "A02", threadId: "t", action: install },
        ],
      },
      (s) => s.replaceAll("/home/me/repo/", ""),
    );
    const state = request.body.state as { actions: Array<Record<string, unknown>> };
    assert.deepStrictEqual(state.actions[0]!.files, ["src/x.ts", "other.ts"]);
    assert.strictEqual(state.actions[0]!.diff, "+const a = 2;");
    assert.notInclude(JSON.stringify(request.body), "secret other");
    assert.isUndefined(state.actions[1]!.output);
    assert.isBelow(String(state.actions[1]!.command).length, 200);
    assert.deepStrictEqual(Object.keys(request.body.questions), ["A01", "A02", "main"]);
    const main = request.body.questions.main!;
    assert.deepStrictEqual(main.type === "choice" && Object.keys(main.criteria), [
      "A01",
      "A02",
      "none",
    ]);
  });

  it("keeps pieces naming the file or running commands when there are too many", () => {
    const [hunk] = hunksOf(DIFF);
    const pieces = [
      {
        id: "A01",
        threadId: "t",
        action: action("other", 1, { kind: "edit", title: "edit y.ts" }),
      },
      {
        id: "A02",
        threadId: "t",
        action: action("own", 2, { kind: "edit", title: "edit src/x.ts" }),
      },
      { id: "A03", threadId: "t", action: action("install", 3, { kind: "setup" }) },
    ];
    const request = buildRequest({ subject: "s", hunk: hunk!, pieces }, (s) => s, {
      hunkBytes: 100,
      diffBytes: 100,
      commandBytes: 100,
      outputBytes: 100,
      briefBytes: 100,
      maxPieces: 2,
    });
    assert.deepStrictEqual(
      request.asked.map((p) => p.id),
      ["A02", "A03"],
    );
    assert.strictEqual(request.dropped, 1);
  });

  it("blames pieces that wrote the lines, and names those that only staged or checked them", () => {
    const asked = ["A01", "A02", "A03"].map((id) => ({
      id,
      threadId: "t",
      action: action(id, 1, {}),
    }));
    // Each piece: P(wrote), and the role the rest goes to.
    const response = (pieces: Array<[number, string]>): SystemOneResponse => ({
      model: "jev-1.13.0",
      answers: {
        ...Object.fromEntries(
          pieces.map(([wrote, other], i) => [
            asked[i]!.id,
            {
              type: "choice" as const,
              choice: wrote >= 0.5 ? "wrote" : other,
              probabilities: { wrote, [other]: 1 - wrote },
              confidence: 0.8,
            },
          ]),
        ),
        main: {
          type: "choice",
          choice: "A02",
          probabilities: { A02: 0.7, none: 0.3 },
          confidence: 0.6,
        },
      },
      usage: { input_tokens: 900 },
    });
    const blame = readBlame(
      { asked },
      response([
        [0.1, "staged"],
        [0.92, "unrelated"],
        [0.4, "unrelated"],
      ]),
    );
    assert.strictEqual(blame.status, "attributed");
    if (blame.status === "attributed") {
      assert.deepStrictEqual(blame.by, [{ id: "A02", p: 0.92 }]);
      assert.deepStrictEqual(blame.possibly, [{ id: "A03", p: 0.4 }]);
      assert.deepStrictEqual(blame.touched, [{ id: "A01", role: "staged", p: 0.9 }]);
      assert.deepStrictEqual(blame.main, { id: "A02", p: 0.7, confidence: 0.6 });
    }
    const low = (w: number): [number, string] => [w, "unrelated"];
    assert.strictEqual(
      readBlame({ asked }, response([low(0.1), low(0.4), low(0.2)])).status,
      "possibly",
    );
    assert.strictEqual(
      readBlame({ asked }, response([low(0.1), low(0.1), low(0.2)])).status,
      "none",
    );
    assert.strictEqual(readBlame({ asked }, response([low(0.1), low(0.9)])).status, "unavailable");
  });

  it("reads GitHub line links from a PR's or a commit's diff", () => {
    const hash = "a".repeat(64);
    assert.deepStrictEqual(parseLineLink(`https://github.com/o/r/pull/47/files#diff-${hash}R63`), {
      repoUrl: "https://github.com/o/r",
      pr: 47,
      sha: null,
      fileHash: hash,
      side: "R",
      line: 63,
    });
    assert.strictEqual(
      parseLineLink(`https://github.com/o/r/pull/47/changes#diff-${hash}L5`)?.side,
      "L",
    );
    assert.strictEqual(
      parseLineLink(`https://github.com/o/r/commit/856d1330#diff-${hash}R10-R12`)?.sha,
      "856d1330",
    );
    assert.isNull(parseLineLink(`https://github.com/o/r/pull/47/files`));
    assert.isNull(parseLineLink(`https://evil.example/o/r/pull/47/files#diff-${hash}R1`));
  });

  it("marks writers, near misses, stagers and actions naming the file", () => {
    const odds = (wrote: number, staged = 0) => ({
      wrote,
      staged,
      checked: 0,
      unrelated: 1 - wrote - staged,
    });
    const marks = marksOf({
      path: "src/x.ts",
      pieces: [
        { id: "A01", threadId: "t", actionId: "a", odds: odds(0.9) },
        { id: "A02", threadId: "t", actionId: "b", odds: odds(0.5) },
        { id: "A03", threadId: "t", actionId: "c", odds: odds(0.1, 0.8) },
        { id: "A04", threadId: "t", actionId: "d", odds: odds(0.1) },
      ],
      threads: [
        {
          id: "t",
          title: "t",
          entries: [
            action("a", 1, {}),
            action("e", 2, { kind: "read", title: "read src/x.ts" }),
            action("f", 3, { kind: "read", title: "read y.ts" }),
          ],
        },
      ],
    });
    assert.deepStrictEqual(Object.fromEntries(marks), {
      a: { tone: "wrote", why: "wrote 0.90" },
      b: { tone: "maybe", why: "wrote? 0.50" },
      c: { tone: "touched", why: "staged it" },
      e: { tone: "touched", why: "names file" },
    });
  });
});

it("decodes Git patch paths with spaces, tabs and quoted UTF-8 bytes", async () => {
  const { hunksOf } = await import("./blame.ts");
  assert.strictEqual(
    hunksOf("--- a/a b.txt\t\n+++ b/a b.txt\t\n@@ -0,0 +1 @@\n+x")[0]?.path,
    "a b.txt",
  );
  assert.strictEqual(
    hunksOf('--- "a/\\303\\251.txt"\n+++ "b/\\303\\251.txt"\n@@ -0,0 +1 @@\n+x')[0]?.path,
    "é.txt",
  );
});

it("maps unchanged duplicate lines back through insertions and deletions", async () => {
  const { originalLine, patchPath } = await import("./blame.ts");
  assert.strictEqual(originalLine("@@ -1,3 +1,4 @@\n same\n+inserted\n same\n last", 3), 2);
  assert.strictEqual(originalLine("@@ -1,3 +1,2 @@\n same\n-removed\n same", 2), 3);
  assert.strictEqual(originalLine("@@ -1 +1,2 @@\n+new\n same", 1), null);
  assert.strictEqual(originalLine("@@ -1 +0,0 @@\n-removed", 1), 2);
  assert.strictEqual(patchPath("b/a b.txt\t"), "a b.txt");
  assert.strictEqual(patchPath('"b/\\303\\251.txt"'), "é.txt");
  assert.strictEqual(patchPath('"b/a\\tname.txt"'), "a\tname.txt");
});
