import { assert, describe, it } from "@effect/vitest";

import type { Action, Entry } from "./domain.ts";
import * as Schema from "effect/Schema";

import {
  buildEntry,
  clipOutputs,
  editedPaths,
  fileCoverage,
  findCommitActions,
  isStale,
  LedgerEntry,
  matchCommit,
  madeEdits,
  mergeEntries,
  mergeLinks,
  segmentByTime,
  segmentFor,
  sessionFromEnv,
  sessionsBetween,
  sessionSegment,
  type LedgerCommit,
  type LedgerLink,
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
const thread = {
  id: "t",
  title: "t",
  source: "codex" as const,
  provider: null,
  origin: null,
  parent: null,
};
const link = (id: string, over: Partial<LedgerLink> = {}): LedgerLink => ({
  thread: { ...thread, id, title: id },
  role: "coder",
  via: "time",
  reviewedSha: null,
  files: [],
  entries: [action(`${id}-a`, "2026-01-01T09:00:00Z", "ls")],
  labels: {},
  ...over,
});
const decodeEntry = Schema.decodeUnknownSync(Schema.fromJsonString(LedgerEntry));
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
      links: [
        {
          thread: { ...thread, title: "Fix it" },
          role: "coder",
          via: "sha",
          reviewedSha: null,
          segment: [
            action("c0", "2026-01-01T09:58:00Z", "pwd", "/home/me/private-client/backend\n"),
            action("c1", "2026-01-01T09:59:00Z", "git commit -m fix"),
          ],
          labels: {},
        },
      ],
      paths: [],
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
    assert.notInclude(JSON.stringify(view), "private-client", "not even as ~/private-client");
    const pwd = view.commits[0]!.entry!.links[0]!.entries[0]!;
    assert.strictEqual(pwd.type === "action" && pwd.output, ".\n");
  });
});

describe("several threads per commit", () => {
  it("keeps one link per thread: the stronger via wins, and an asserted link is never dropped", () => {
    const asserted = link("s1", { via: "asserted", role: "reviewer", entries: [] });
    const merged = mergeLinks(
      [asserted],
      [link("s1", { via: "sha" }), link("s2", { via: "evidence" })],
    );
    assert.deepStrictEqual(
      merged.map((l) => [l.thread.id, l.via, l.role]),
      [
        ["s1", "asserted", "reviewer"],
        ["s2", "evidence", "coder"],
      ],
    );
    assert.strictEqual(
      merged[0]!.entries.length,
      1,
      "an asserted link takes the history sync found",
    );
    assert.strictEqual(mergeLinks([link("s1", { via: "evidence" })], [link("s1")])[0]!.via, "time");
  });

  it("puts each changed file in exactly one bucket", () => {
    const files = fileCoverage(
      ["a.ts", "b.ts", "c.ts"],
      [link("s1", { files: ["a.ts", "b.ts"] }), link("s2", { files: ["b.ts"] })],
    );
    assert.deepStrictEqual(
      files.map((f) => [f.path, f.bucket]),
      [
        ["a.ts", "attributed"],
        ["b.ts", "shared"],
        ["c.ts", "untracked"],
      ],
    );
  });

  it("counts edits and shell writes to a commit's files, never reads or git add", () => {
    const cases: Array<[string, boolean]> = [
      ["sed -i 's/x/y/' src/a.ts", true],
      ["echo x > src/a.ts", true],
      ["/bin/zsh -lc 'cat > a.ts <<EOF\nhi\nEOF'", true],
      ["cat src/a.ts", false],
      ["rg foo src/a.ts", false],
      ["git add src/a.ts", false],
    ];
    for (const [command, counts] of cases)
      assert.strictEqual(
        editedPaths([action("x", "2026-01-01T09:00:00Z", command)], ["src/a.ts"]).has("src/a.ts"),
        counts,
        command,
      );
    const edit: Action = {
      ...action("e", "2026-01-01T09:00:00Z", "apply_patch"),
      kind: "edit",
      files: [{ path: "/w/repo/src/a.ts", added: 1, removed: 0, isNew: false, isDeleted: false }],
    };
    assert.deepStrictEqual([...editedPaths([edit], ["src/a.ts", "a.ts"])], ["src/a.ts"]);
    assert.strictEqual(editedPaths([{ ...edit, status: "failed" }], ["src/a.ts"]).size, 0);
  });

  it("takes history between the previous commit and this one", () => {
    const entries = [
      user("u0", "2026-01-01T08:00:00Z"),
      action("a0", "2026-01-01T08:01:00Z", "ls"),
      user("u1", "2026-01-01T09:00:00Z"),
      action("a1", "2026-01-01T09:01:00Z", "ls"),
      action("a2", "2026-01-01T11:00:00Z", "ls"),
    ];
    assert.deepStrictEqual(
      segmentByTime(entries, "2026-01-01T08:30:00Z", "2026-01-01T10:00:00Z").map((e) => e.id),
      ["u1", "a1"],
    );
  });

  it("marks a review stale on any commit but the one reviewed", () => {
    const review = link("r", { role: "reviewer", reviewedSha: "a1b2" });
    assert.isFalse(isStale(review, "a1b2"));
    assert.isTrue(isStale(review, "e4f5"));
    assert.isFalse(isStale(link("c"), "e4f5"), "only reviews go stale");
  });

  it("names the agent session from what the agent exports", () => {
    assert.strictEqual(sessionFromEnv({ CODEX_THREAD_ID: "01a0" }), "codex:01a0");
    assert.strictEqual(sessionFromEnv({ CLAUDE_CODE_SESSION_ID: "7c2e" }), "claude-code:7c2e");
    assert.isNull(sessionFromEnv({}));
  });

  it("reads a v1 entry as one coder link", () => {
    const v1 = {
      formatVersion: 1,
      commit: commit("a".repeat(40), "2026-01-01T10:00:00Z"),
      thread: { id: "t1", title: "Do it", source: "codex", provider: null, origin: null },
      match: "time",
      outputs: "included",
      redactions: 2,
      entries: [action("c1", "2026-01-01T09:59:00Z", "git commit -m x")],
      labels: { c1: "commit" },
    };
    const entry = decodeEntry(JSON.stringify(v1));
    assert.strictEqual(entry.formatVersion, 2);
    assert.deepStrictEqual(
      entry.links.map((l) => [l.thread.id, l.role, l.via, l.entries.length, l.labels]),
      [["t1", "coder", "time", 1, { c1: "commit" }]],
    );
  });

  it("adds a note and a link to an entry, and adds nothing twice", () => {
    const c = commit("a".repeat(40), "2026-01-01T10:00:00Z");
    const empty = buildEntry({
      commit: c,
      links: [],
      paths: ["a.ts"],
      outputs: true,
      maxOutput: 0,
    });
    assert.deepStrictEqual(empty.files, [{ path: "a.ts", bucket: "untracked" }]);
    const fresh = {
      ...empty,
      links: [link("s1", { files: ["a.ts"] })],
      notes: [{ text: "by hand", file: "a.ts", at: "2026-01-01T11:00:00Z" }],
    };
    const once = mergeEntries(empty, fresh);
    assert.deepStrictEqual(once.files, [{ path: "a.ts", bucket: "attributed" }]);
    assert.deepStrictEqual(mergeEntries(once, fresh), once);
  });
});
