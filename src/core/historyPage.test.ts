import { assert, describe, it } from "@effect/vitest";

import type { Entry } from "./domain.ts";
import { episode, historyRange } from "./historyPage.ts";
import type { CommitRecord, ThreadRecord } from "./historyRecord.ts";

const at = (minute: number) => `2026-01-01T10:${String(minute).padStart(2, "0")}:00.000Z`;
const turn = (n: number): Entry[] => [
  { type: "message", id: `u${n}`, at: at(n * 2), role: "user", text: `turn ${n}` },
  { type: "message", id: `a${n}`, at: at(n * 2 + 1), role: "assistant", text: `done ${n}` },
];

describe("history page", () => {
  it("shows a link's turns with the short runs between them, not long ones", () => {
    const entries = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].flatMap(turn);
    const ids = (e: Entry[]) => e.filter((x) => x.id.startsWith("u")).map((x) => x.id);
    // u2 and u4: the turn between stays. u4 and u9: four turns between, a separate episode.
    assert.deepStrictEqual(ids(episode(entries, new Set(["u2", "u4", "u9"]))), [
      "u2",
      "u3",
      "u4",
      "u9",
    ]);
  });

  it("builds each commit's entry from its links, and says how much of it agents wrote", () => {
    const thread: ThreadRecord = {
      formatVersion: 1,
      thread: {
        id: "t1",
        title: "Add a",
        source: "codex",
        provider: "codex",
        origin: null,
        parent: null,
      },
      takenAt: at(30),
      toolreaderVersion: "0.1.0",
      entries: [1, 2].flatMap(turn),
      labels: {},
      redactions: 0,
    };
    const record: CommitRecord = {
      formatVersion: 1,
      repo: "acme/app",
      sha: "abc1234",
      subject: "feat: a",
      committedAt: at(40),
      novel: 10,
      explained: 7,
      links: [{ threadId: "t1", turns: ["u2"], via: "content", lines: 7 }],
      linkedAt: at(41),
      toolreaderVersion: "0.1.0",
    };
    const commit = { sha: "abc1234", subject: "feat: a", committedAt: at(40), patchId: null };
    const range = historyRange({
      repo: "acme/app",
      range: "main..feat",
      remoteUrl: "https://github.com/acme/app",
      commits: [
        { commit, paths: ["a.ts"], record },
        { commit: { ...commit, sha: "def5678" }, paths: [], record: null },
      ],
      threads: new Map([["t1", thread]]),
    });
    const [linked, none] = range.commits;
    assert.deepStrictEqual(
      linked?.entry?.links.map((l) => [l.thread.id, l.via, l.entries.map((e) => e.id)]),
      [["t1", "content", ["u2", "a2"]]],
    );
    assert.include(linked?.entry?.notes[0]?.text, "7 of the 10 lines");
    assert.isNull(none?.entry);
  });
});
