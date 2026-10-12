import { assert, describe, it } from "@effect/vitest";

import type { Action, Entry } from "./domain.ts";
import { findCommitActions, madeEdits, type LedgerCommit } from "./ledger.ts";
import {
  linkCommits,
  selectScope,
  signalsFor,
  type LinkCommit,
  type LinkSession,
} from "./linking.ts";
import { humanizeCommand, strongestKind } from "./shell.ts";

/** A shell action as `normalize` makes one: an agent with no edit or read tool (Pi-style). */
const sh = (id: string, at: string, command: string, output?: string): Action => {
  const parts = humanizeCommand(command);
  return {
    type: "action",
    id,
    at,
    kind: parts.length ? strongestKind(parts.map((p) => p.kind)) : "run",
    status: "ok",
    title: command,
    command,
    ...(output ? { output } : {}),
  };
};
const prompt = (id: string, at: string): Entry => ({
  type: "message",
  id,
  at,
  role: "user",
  text: id,
});
const session = (id: string, here: boolean, entries: Entry[]): LinkSession => ({
  here,
  edited: madeEdits(entries),
  entries,
  actions: findCommitActions(entries),
  labels: {},
  thread: { id, title: id, source: "codex", provider: null, origin: null, parent: null },
});
const ledgerCommit = (sha: string, committedAt: string): LedgerCommit => ({
  sha,
  subject: "s",
  committedAt,
  patchId: null,
});
const options = (sessions: ReadonlyArray<LinkSession>) => ({
  named: (name: string) => sessions.filter((s) => `codex:${s.thread.id}` === name),
  sessions: [],
  matchSessions: false,
  roots: ["/w/repo"],
});
const at = (minute: number) => `2026-01-01T10:${String(minute).padStart(2, "0")}:00Z`;
const kinds = (entries: Entry[], paths = ["src/a.ts"]) =>
  signalsFor(entries, paths, { roots: ["/w/repo"] }).map((s) => [s.kind, ...s.paths].join(" "));

describe("linking", () => {
  it("reads what a shell-only session did to a commit's files", () => {
    const cases: Array<[string, string | undefined, string[]]> = [
      [
        "git apply <<'EOF'\ndiff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\nEOF",
        undefined,
        ["write src/a.ts", "active"],
      ],
      ["patch -p1 < fix.diff", "patching file src/a.ts\n", ["write src/a.ts", "active"]],
      [
        "apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch\nEOF",
        undefined,
        ["write src/a.ts", "active"],
      ],
      ["git mv src/old.ts src/a.ts", undefined, ["write src/a.ts", "active"]],
      ["git checkout -- src/a.ts", undefined, ["write src/a.ts", "active"]],
      ["git restore --staged src/a.ts", undefined, ["active"]],
      ["git add src/a.ts", undefined, ["staged src/a.ts", "active"]],
      ["git add -A && git status", undefined, ["staged", "active"]],
      [
        "python3 - <<'EOF'\nopen('src/a.ts', 'w').write(s)\nEOF",
        undefined,
        ["script src/a.ts", "active"],
      ],
      [
        `node -e "require('fs').writeFileSync('src/a.ts', s)"`,
        undefined,
        ["script src/a.ts", "active"],
      ],
      ["npx prettier --write src/a.ts:3", undefined, ["script src/a.ts", "active"]],
      [
        "/bin/zsh -lc 'git status --short'",
        " M src/a.ts\n?? x.md\n",
        ["inspected src/a.ts", "active"],
      ],
      ["sed -n '1,40p' src/a.ts", undefined, ["read src/a.ts", "active"]],
      ["python3 gen.py", undefined, ["active"]],
      // Outside the repo's worktrees, an absolute path is another file.
      ["python3 fix.py /tmp/x/src/a.ts", undefined, ["active"]],
      // A diff that is only written somewhere is not applied.
      ["cat > notes.md <<'EOF'\n+++ b/src/a.ts\nEOF", undefined, ["active"]],
    ];
    for (const [command, output, expected] of cases)
      assert.deepStrictEqual(kinds([sh("x", at(1), command, output)]), expected, command);
    const failed: Action = { ...sh("x", at(1), "git add src/a.ts"), status: "failed" };
    assert.deepStrictEqual(kinds([failed]), [], "a failed command shows nothing");
    const tool: Action = {
      type: "action",
      id: "r",
      at: at(1),
      kind: "read",
      status: "ok",
      title: "read",
      targets: ["/w/repo/src/a.ts"],
    };
    assert.deepStrictEqual(kinds([tool]), ["read src/a.ts", "active"], "a read tool");
  });

  it("links as ledger sync does and takes nothing else; signals wait for a person", () => {
    const sha = "abc1234def5678";
    const coder = session("coder", true, [
      prompt("p", at(5)),
      sh("c1", at(6), "git add -A"),
      sh("c2", at(7), "git commit -m x"),
    ]);
    const printed = session("printed", false, [
      prompt("p", at(5)),
      sh("p1", at(8), "git commit -m x", `[main ${sha.slice(0, 7)}] x\n`),
    ]);
    const shellOnly = session("shell", true, [
      prompt("p", at(5)),
      sh("t1", at(9), "echo x > src/a.ts"),
    ]);
    const stager = session("stager", true, [
      prompt("p", at(5)),
      sh("s1", at(10), "git add src/a.ts"),
    ]);
    const busy = session("busy", true, [prompt("p", at(5)), sh("b1", at(11), "python3 gen.py")]);
    const earlier = session("earlier", true, [
      prompt("p", "2026-01-01T09:00:00Z"),
      sh("e1", "2026-01-01T09:01:00Z", "git add src/a.ts"),
    ]);
    const elsewhere = session("elsewhere", false, [
      prompt("p", at(5)),
      sh("o1", at(9), "echo x > src/a.ts"),
    ]);
    const sessions = [coder, printed, shellOnly, stager, busy, earlier, elsewhere];
    const commit: LinkCommit = {
      commit: ledgerCommit(sha, at(20)),
      previousAt: at(0),
      trailers: ["codex:coder"],
      paths: ["src/a.ts"],
    };

    const links = linkCommits([commit], sessions, options(sessions));
    assert.deepStrictEqual(
      links[0]!.links.map((l) => `${l.thread.id} ${l.via}`),
      ["coder trailer", "printed sha", "shell evidence"],
    );
    const scope = selectScope(links, sessions, { roots: ["/w/repo"] });
    assert.deepStrictEqual(
      scope.take.map((t) => t.link.thread.id),
      ["coder", "printed", "shell"],
    );
    assert.deepStrictEqual(
      scope.candidates.map((j) => `${j.thread.id} ${j.signals.map((s) => s.kind).join(",")}`),
      ["stager staged,active", "busy active"],
      "strongest first; a session silent in the window, or in another worktree, is left out",
    );
    assert.deepStrictEqual(scope.candidates[0]!.signals[0]!.ids, ["s1"]);
    assert.deepStrictEqual(scope.unmatched, []);
  });

  it("attaches no session to a commit several could have made, and offers each as a candidate", () => {
    const a = session("a", true, [prompt("p", at(1)), sh("a1", at(2), "echo x > b.ts")]);
    const b = session("b", true, [prompt("p", at(1)), sh("b1", at(3), "echo y > c.ts")]);
    const commit: LinkCommit = {
      commit: ledgerCommit("f".repeat(40), at(10)),
      previousAt: at(0),
      trailers: [],
      paths: ["a.ts"],
    };
    const links = linkCommits([commit], [a, b], { ...options([a, b]), matchSessions: true });
    assert.deepStrictEqual(links[0]!.ambiguous, ["a", "b"]);
    const scope = selectScope(links, [a, b]);
    assert.deepStrictEqual(scope.take, []);
    assert.deepStrictEqual(
      scope.ambiguous.map((x) => x.sessions),
      [["a", "b"]],
    );
    assert.deepStrictEqual(
      scope.candidates.map((j) => j.thread.id),
      ["a", "b"],
    );
    assert.deepStrictEqual(scope.unmatched, []);
    // A merge (no files) gets no candidates.
    const merge = selectScope(linkCommits([{ ...commit, paths: [] }], [a, b], options([a, b])), [
      a,
      b,
    ]);
    assert.deepStrictEqual([merge.candidates, merge.unmatched.length], [[], 1]);
  });

  it("gives a stacked PR's commit the turns, in any worktree, that edited its files", () => {
    const edit = (id: string, minute: number, path: string): Action => ({
      type: "action",
      id,
      at: at(minute),
      kind: "edit",
      status: "ok",
      title: path,
      files: [{ path, added: 1, removed: 0, isNew: false, isDeleted: false }],
    });
    // Written in another worktree, before the split moved the file into backend/.
    const work = session("work", false, [
      prompt("u1", at(1)),
      edit("e1", 2, "/w/wt/src/server/Store.ts"),
      prompt("u2", at(3)),
      edit("e2", 4, "README.md"),
      prompt("u3", at(5)),
      sh("c1", at(6), "git commit -m split", "[main abc1234] split"),
    ]);
    const commit: LinkCommit = {
      commit: ledgerCommit("abc1234", at(30)),
      previousAt: at(29),
      trailers: [],
      paths: ["src/server/backend/Store.ts", "README.md"],
    };
    const [linked] = linkCommits([commit], [work], {
      ...options([work]),
      roots: ["/w/repo", "/w/wt"],
      historySince: at(0),
      trees: new Map([["abc1234", new Set(["src/server/backend/Store.ts", "README.md"])]]),
    });
    // Only the editing turns; the `git commit` turn is bookkeeping, not this commit's history.
    assert.deepStrictEqual(
      linked?.links.map((l) => [l.via, l.segment.map((e) => e.id)]),
      [["evidence", ["u1", "e1", "u2", "e2"]]],
    );
  });
});
