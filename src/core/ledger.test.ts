import { assert, describe, it } from "@effect/vitest";

import type { Action } from "./domain.ts";
import * as Schema from "effect/Schema";

import {
  buildEntry,
  remoteWebUrl,
  clipOutputs,
  editedPaths,
  fileCoverage,
  isStale,
  LedgerEntry,
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

describe("ledger", () => {
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
    // Absolute and `~/` paths count only inside a worktree of the repo, compared exactly.
    const roots = { roots: ["/w/repo", "/w/repo-wt"], home: "/w" };
    assert.deepStrictEqual([...editedPaths([edit], ["src/a.ts", "a.ts"], roots)], ["src/a.ts"]);
    const sibling = { ...edit, files: [{ ...edit.files![0]!, path: "~/repo-wt/src/a.ts" }] };
    assert.deepStrictEqual([...editedPaths([sibling], ["src/a.ts"], roots)], ["src/a.ts"]);
    const other = { ...edit, files: [{ ...edit.files![0]!, path: "~/other/src/a.ts" }] };
    assert.strictEqual(editedPaths([other], ["src/a.ts"], roots).size, 0, "another repo");
    const tmp = action("t", "2026-01-01T09:00:00Z", "echo x > /tmp/a.ts");
    assert.strictEqual(editedPaths([tmp], ["a.ts"], roots).size, 0);
    assert.strictEqual(
      editedPaths([edit], ["src/a.ts"]).size,
      0,
      "no worktrees, no absolute match",
    );
    assert.strictEqual(editedPaths([{ ...edit, status: "failed" }], ["src/a.ts"], roots).size, 0);
  });

  it("marks a review stale on any commit but the one reviewed", () => {
    const review = link("r", { role: "reviewer", reviewedSha: "a1b2" });
    assert.isFalse(isStale(review, "a1b2"));
    assert.isTrue(isStale(review, "e4f5"));
    assert.isFalse(isStale(link("c"), "e4f5"), "only reviews go stale");
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

  it("names a repo by its remote, in every URL form git takes", () => {
    for (const remote of [
      "git@github.com:acme/app.git",
      "https://github.com/acme/app.git",
      "ssh://git@github.com/acme/app.git",
      "ssh://git@github.com:22/acme/app",
    ])
      assert.strictEqual(remoteWebUrl(remote), "https://github.com/acme/app", remote);
  });
});
