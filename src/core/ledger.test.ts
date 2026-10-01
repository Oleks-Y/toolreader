import { assert, describe, it } from "@effect/vitest";

import type { Action, Entry } from "./domain.ts";
import {
  buildEntry,
  clipOutputs,
  findCommitActions,
  matchCommit,
  madeEdits,
  segmentFor,
  sessionsBetween,
  sessionSegment,
  type LedgerCommit,
} from "./ledger.ts";
import { publicRange } from "./ledgerSite.ts";

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
    "grep",
    "2026-01-01T10:04:10Z",
    "rg 'git commit' src && cat <<EOF\n/** `git commit` */\nEOF",
  ),
  action(
    "c2",
    "2026-01-01T10:05:00Z",
    "git commit -m two",
    "[feat/x 1a2b3c4] two\n 1 file changed\n[feat/x 5d6e7f8] three\n 1 file changed",
  ),
];

describe("ledger", () => {
  it("finds successful git commit actions and their printed SHAs", () => {
    assert.deepStrictEqual(
      findCommitActions(entries).map((a) => [a.action.id, a.shas]),
      [
        ["c1", []],
        ["c2", ["1a2b3c4", "5d6e7f8"]],
      ],
    );
    const wrapped = [
      action("w", "2026-01-01T10:00:00Z", `/bin/zsh -lc "git commit -m 'feat: x'"`),
      action("echo", "2026-01-01T10:00:00Z", `/bin/zsh -lc 'echo "git commit"'`),
    ];
    assert.deepStrictEqual(
      findCommitActions(wrapped).map((a) => a.action.id),
      ["w"],
      "inside a shell wrapper",
    );
  });

  it("matches by printed SHA first, else by the latest commit action shortly before the commit time", () => {
    const actions = findCommitActions(entries);
    assert.deepStrictEqual(
      matchCommit(commit("1a2b3c4d5e6f", "2026-01-01T10:05:03Z"), actions)?.action.action.id,
      "c2",
    );
    assert.deepStrictEqual(
      matchCommit(commit("5d6e7f8a9b", "2026-01-01T10:05:04Z"), actions),
      { action: actions[1]!, match: "sha" },
      "second commit of one command",
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
      ["u1", "e2", "bad", "u2", "grep", "c2"],
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

  it("finds the sessions that ended between the previous commit and this one", () => {
    // CI: `codex exec` edits (the sandbox blocks .git), a later step commits.
    const edits: Entry[] = [
      user("p", "2026-01-01T10:00:00Z"),
      action("w1", "2026-01-01T10:01:00Z", "sed -i x a.ts"),
      action("w2", "2026-01-01T10:02:00Z", "npm test"),
    ];
    const older = { entries: [action("o", "2026-01-01T08:00:00Z", "sed -i o a.ts")] };
    const latest = { entries: edits };
    const at = commit("abc", "2026-01-01T10:05:00Z");
    assert.deepStrictEqual(sessionsBetween(at, "2026-01-01T09:00:00Z", [older, latest]), [latest]);
    assert.deepStrictEqual(
      sessionsBetween(at, null, [older, latest]),
      [older, latest],
      "first commit: no lower bound, and every candidate is returned",
    );
    assert.deepStrictEqual(
      sessionsBetween(at, "2026-01-01T10:03:00Z", [latest]),
      [],
      "ended before the previous commit",
    );
    assert.deepStrictEqual(
      sessionsBetween(commit("abc", "2026-01-01T10:01:30Z"), null, [latest]),
      [],
      "still running at commit time",
    );
    // Edits count, by tool or by a shell command that writes; reading and testing don't.
    const run = (id: string, kind: Action["kind"], parts: Action["parts"] = []): Action => ({
      ...action(id, "2026-01-01T10:00:00Z", id),
      kind,
      parts,
    });
    assert.isTrue(madeEdits([run("patch", "edit")]));
    assert.isTrue(madeEdits([run("chain", "test", [{ kind: "edit", title: "write f.ts" }])]));
    assert.isFalse(madeEdits([run("diff", "read"), run("test", "test")]));
    assert.isFalse(madeEdits([{ ...run("bad", "edit"), status: "failed" }]));
    // Only what came after the previous commit and after the session's own last commit action.
    const mixed: Entry[] = [...entries, action("w3", "2026-01-01T10:20:00Z", "sed -i z c.ts")];
    assert.deepStrictEqual(
      sessionSegment(mixed, findCommitActions(mixed), "2026-01-01T10:06:00Z").map((e) => e.id),
      ["u2", "w3"],
    );
    assert.deepStrictEqual(
      sessionSegment(edits, [], "2026-01-01T10:00:30Z").map((e) => e.id),
      ["p", "w1", "w2"],
    );
  });

  it("clips outputs to head and tail on character boundaries", () => {
    const long = action(
      "x",
      "2026-01-01T10:00:00Z",
      "cat log",
      `${"a".repeat(10)}éé${"b".repeat(10)}`,
    );
    const [clipped] = clipOutputs([long], 12);
    assert.deepStrictEqual(clipped, {
      ...long,
      output: "aaaaaa\n… [12 bytes clipped] …\nbbbbbb",
      clipped: 12,
    });
    // Cuts never split the two-byte "é".
    const [accents] = clipOutputs([{ ...long, output: "ééééé" }], 5);
    assert.strictEqual(accents?.type === "action" && accents.output, "é\n… [6 bytes clipped] …\né");
    assert.deepStrictEqual(clipOutputs([long], 0), [long], "0 keeps outputs whole");
    assert.deepStrictEqual(clipOutputs([long], 100), [long], "short outputs stay");
  });

  it("publishes a range by its remote's owner/name, with commit subjects redacted", () => {
    const commit: LedgerCommit = {
      sha: "a".repeat(40),
      subject: "fix: API_TOKEN=supersecret in /home/me/proj",
      committedAt: "2026-01-01T10:00:00Z",
      patchId: null,
    };
    const entry = buildEntry({
      commit,
      thread: { id: "t", title: "Fix it", source: "codex", provider: null, origin: null },
      match: "sha",
      segment: [action("c1", "2026-01-01T09:59:00Z", "git commit -m fix")],
      labels: {},
      outputs: true,
      maxOutput: 0,
      home: "/home/me",
    });
    assert.strictEqual(entry.commit.subject, "fix: API_TOKEN=[redacted] in ~/proj");
    const view = publicRange(
      {
        repo: "/home/me/private-client/backend",
        range: "main..HEAD",
        remoteUrl: "https://github.com/acme/backend",
        commits: [{ commit, entry: { ...entry, commit }, matchedBy: "sha" }],
      },
      "/home/me",
    );
    assert.strictEqual(view.repo, "acme/backend");
    assert.strictEqual(view.commits[0]!.commit.subject, "fix: API_TOKEN=[redacted] in ~/proj");
    assert.strictEqual(
      view.commits[0]!.entry!.commit.subject,
      "fix: API_TOKEN=[redacted] in ~/proj",
    );
    assert.notInclude(JSON.stringify(view), "/home/me");
  });
});
