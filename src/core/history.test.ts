import { assert, describe, it } from "@effect/vitest";

import type { Action, Entry } from "./domain.ts";
import { addedLines, linkByContent, type CommitLines, type HistoryThread } from "./history.ts";

const at = (minute: number) => `2026-01-01T10:${String(minute).padStart(2, "0")}:00Z`;
const prompt = (id: string, minute: number): Entry => ({
  type: "message",
  id,
  at: at(minute),
  role: "user",
  text: id,
});
const edit = (id: string, minute: number, path: string, lines: string[]): Action => ({
  type: "action",
  id,
  at: at(minute),
  kind: "edit",
  status: "ok",
  title: path,
  files: [
    {
      path,
      added: lines.length,
      removed: 0,
      isNew: false,
      isDeleted: false,
      diff: `@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`,
    },
  ],
});
const commit = (sha: string, minute: number, novel: string[], trailers: string[] = []) =>
  ({ sha, committedAt: at(minute), trailers, novel }) satisfies CommitLines;

describe("history", () => {
  it("reads a diff's added lines, leaving out headers and lines too short to tell", () => {
    assert.deepStrictEqual(
      addedLines(
        "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1,3 @@\n-old line here\n+  const total =   sum(a, b);\n+}\n+ok",
      ),
      ["const total = sum(a, b);"],
    );
    // An added `++index_of_row;` reads `+++index_of_row;` in the diff: a line, not a header.
    assert.deepStrictEqual(addedLines("@@ -1 +1 @@\n-index_of_row++;\n+++index_of_row;"), [
      "++index_of_row;",
    ]);
  });

  it("links each commit of a split to the turns that wrote its lines, wherever they ran", () => {
    // One thread wrote two features, days before they were split into two commits (and a file
    // was moved: paths don't matter).
    const work: HistoryThread = {
      id: "work",
      entries: [
        prompt("u1", 1),
        edit("e1", 2, "/elsewhere/src/store.ts", ["export function saveThread(record) {", "}"]),
        prompt("u2", 3),
        edit("e2", 4, "/elsewhere/src/client.ts", ["export async function uploadThreads() {"]),
        prompt("u3", 5),
        edit("e3", 6, "/elsewhere/README.md", ["Run toolreader history sync after a push."]),
      ],
    };
    const other: HistoryThread = {
      id: "other",
      entries: [prompt("v1", 1), edit("f1", 2, "src/a.ts", ["something else entirely here"])],
    };
    const [store, client] = linkByContent(
      [
        commit("s1", 30, ["export function saveThread(record) {"]),
        commit("s2", 31, ["export async function uploadThreads() {", "a line nobody wrote, yet"]),
      ],
      [work, other],
    );
    const { hits, ...linked } = store!;
    assert.deepStrictEqual(linked, {
      sha: "s1",
      novel: 1,
      explained: 1,
      links: [{ threadId: "work", turns: ["u1"], via: "content", lines: 1 }],
    });
    assert.deepStrictEqual(
      [...(hits?.get("work") ?? [])],
      ["export function saveThread(record) {"],
    );
    assert.deepStrictEqual([client?.novel, client?.explained], [2, 1]);
    assert.deepStrictEqual(
      client?.links.map((l) => [l.threadId, l.turns]),
      [["work", ["u2"]]],
    );
  });

  it("needs three of a commit's new lines, or half of them, to link a thread", () => {
    const lines = [
      "const alpha = makeThing(1);",
      "const beta = makeThing(2);",
      "const gamma = makeThing(3);",
      "const delta = makeThing(4);",
    ];
    const once: HistoryThread = {
      id: "once",
      entries: [prompt("u1", 1), edit("e1", 2, "a.ts", lines.slice(0, 1))],
    };
    const thrice: HistoryThread = {
      id: "thrice",
      entries: [prompt("v1", 1), edit("f1", 2, "a.ts", lines.slice(1))],
    };
    const [big, small] = linkByContent(
      [commit("c1", 30, lines), commit("c2", 31, lines.slice(0, 1))],
      [once, thrice],
    );
    assert.deepStrictEqual(
      big?.links.map((l) => l.threadId),
      ["thrice"],
    );
    assert.strictEqual(big?.explained, 3);
    // A one-line fix: its one line is all of it.
    assert.deepStrictEqual(
      small?.links.map((l) => l.threadId),
      ["once"],
    );
  });

  it("still finds what a big write added after the viewer clipped its diff", () => {
    const write = edit("e1", 2, "src/big.ts", ["export const first = 'kept in the diff';"]);
    const clipped: Action = {
      ...write,
      files: write.files!.map((f) => ({
        ...f,
        truncated: true,
        addedKeys: [
          "export const first = 'kept in the diff';",
          "export const last = 'cut from the diff';",
        ],
      })),
    };
    const [c] = linkByContent(
      [commit("c1", 30, ["export const last = 'cut from the diff';"])],
      [{ id: "big", entries: [prompt("u1", 1), clipped] }],
    );
    assert.deepStrictEqual(
      c?.links.map((l) => l.threadId),
      ["big"],
    );
  });

  it("credits only lines written before the commit, and names trailer threads outright", () => {
    const late: HistoryThread = {
      id: "late",
      entries: [prompt("u1", 40), edit("e1", 41, "src/x.ts", ["export const answer = 42;"])],
    };
    const [c] = linkByContent(
      [commit("c1", 30, ["export const answer = 42;"], ["codex:named"])],
      [late],
      (name) => (name === "codex:named" ? ["named"] : []),
    );
    assert.deepStrictEqual(c?.links, [{ threadId: "named", turns: [], via: "trailer", lines: 0 }]);
    assert.strictEqual(c?.explained, 0);
  });
});
