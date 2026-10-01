import { assert, describe, it } from "@effect/vitest";

import type { Action, Entry } from "./domain.ts";
import { findCommitActions, matchCommit, segmentFor, type LedgerCommit } from "./ledger.ts";

const action = (
  id: string,
  at: string,
  command: string,
  output?: string,
  status: Action["status"] = "ok",
): Action => ({
  type: "action",
  id,
  at,
  kind: "git",
  status,
  title: command,
  command,
  ...(output ? { output } : {}),
});
const user = (id: string, at: string): Entry => ({
  type: "message",
  id,
  at,
  role: "user",
  text: id,
});
const commit = (sha: string, committedAt: string): LedgerCommit => ({
  sha,
  subject: "s",
  committedAt,
  patchId: null,
});

const entries: Entry[] = [
  user("u1", "2026-01-01T10:00:00Z"),
  action("e1", "2026-01-01T10:01:00Z", "sed -i x a.ts"),
  action("c1", "2026-01-01T10:02:00Z", "git add -A && git -c user.email=x commit -q -m one"),
  action("e2", "2026-01-01T10:03:00Z", "sed -i y b.ts"),
  action("bad", "2026-01-01T10:03:30Z", "git commit -m nope", "nothing to commit", "failed"),
  user("u2", "2026-01-01T10:04:00Z"),
  action(
    "c2",
    "2026-01-01T10:05:00Z",
    "git commit -m two",
    "[feat/x 1a2b3c4] two\n 1 file changed",
  ),
];

describe("ledger", () => {
  it("finds successful git commit actions and their printed SHAs", () => {
    assert.deepStrictEqual(
      findCommitActions(entries).map((a) => [a.action.id, a.sha]),
      [
        ["c1", null],
        ["c2", "1a2b3c4"],
      ],
    );
  });

  it("matches by printed SHA first, else by the latest commit action shortly before the commit time", () => {
    const actions = findCommitActions(entries);
    assert.deepStrictEqual(
      matchCommit(commit("1a2b3c4d5e6f", "2026-01-01T10:05:03Z"), actions)?.action.action.id,
      "c2",
    );
    const quiet = matchCommit(commit("ffff000", "2026-01-01T10:02:27Z"), actions);
    assert.deepStrictEqual([quiet?.action.action.id, quiet?.match], ["c1", "time"]);
    assert.strictEqual(
      matchCommit(commit("eeee000", "2026-01-01T12:00:00Z"), actions),
      null,
      "too late",
    );
    assert.strictEqual(
      matchCommit(commit("dddd000", "2026-01-01T09:59:00Z"), actions),
      null,
      "before any commit",
    );
  });

  it("segments history between consecutive commits in a thread", () => {
    const actions = findCommitActions(entries);
    assert.deepStrictEqual(
      segmentFor(entries, actions[0]!, actions).map((e) => e.id),
      ["u1", "e1", "c1"],
    );
    assert.deepStrictEqual(
      segmentFor(entries, actions[1]!, actions).map((e) => e.id),
      // Starts mid-turn, so the turn's prompt (u1) comes back for context.
      ["u1", "e2", "bad", "u2", "c2"],
    );
  });

  it("drops leading discussion-only turns from a segment", () => {
    const talk: Entry[] = [
      action("c0", "2026-01-01T09:00:00Z", "git commit -q -m zero"),
      user("q1", "2026-01-01T09:10:00Z"),
      { type: "message", id: "a1", at: "2026-01-01T09:10:05Z", role: "assistant", text: "design…" },
      user("q2", "2026-01-01T09:20:00Z"),
      action("w1", "2026-01-01T09:21:00Z", "sed -i x a.ts"),
      action("c1", "2026-01-01T09:22:00Z", "git commit -q -m one"),
    ];
    const actions = findCommitActions(talk);
    assert.deepStrictEqual(
      segmentFor(talk, actions[1]!, actions).map((e) => e.id),
      ["q2", "w1", "c1"],
    );
  });
});
