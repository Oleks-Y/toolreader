import { assert, describe, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  admitCheckpoint,
  buildCheckpoint,
  Checkpoint,
  checkpointKey,
  readCheckpoint,
  toLedgerEntry,
} from "./checkpoint.ts";
import v1 from "./fixtures/checkpoint-v1.json" with { type: "json" };
import type { Action, Entry } from "./domain.ts";
import { buildEntry, type LedgerCommit, type LedgerThread } from "./ledger.ts";
import { redactText } from "./proof.ts";

const HOME = "/Users/me";
const TOKEN = "ghp_0123456789abcdefghijABCDEFGHIJ012345";

const user = (id: string, at: string, text = id): Entry => ({
  type: "message",
  id,
  at,
  role: "user",
  text,
});
const action = (id: string, at: string, kind: Action["kind"], extra: Partial<Action> = {}) =>
  ({ type: "action", id, at, kind, status: "ok", title: id, ...extra }) satisfies Action;

const entries: Entry[] = [
  user("u1", "2026-01-01T10:00:00Z", `use ${TOKEN} from ${HOME}/notes`),
  action("r1", "2026-01-01T10:00:10Z", "read"),
  action("e1", "2026-01-01T10:00:20Z", "edit", {
    files: [{ path: "src/a.ts", added: 3, removed: 1, isNew: false, isDeleted: false }],
  }),
  action("t1", "2026-01-01T10:00:30Z", "test"),
  user("u2", "2026-01-01T10:01:00Z"),
  action("e2", "2026-01-01T10:01:10Z", "edit", {
    files: [{ path: "src/a.ts", added: 1, removed: 0, isNew: false, isDeleted: false }],
  }),
  action("c1", "2026-01-01T10:01:20Z", "git", { command: "git commit -m fix" }),
];
const thread: LedgerThread = {
  id: "t3-thread",
  title: `fix ${TOKEN}`,
  source: "t3",
  provider: "codex",
  origin: null,
  parent: null,
};
const commit: LedgerCommit = {
  sha: "abc123",
  subject: `fix with ${TOKEN}`,
  committedAt: "2026-01-01T10:01:30Z",
  patchId: "p1",
};
const base = {
  takenAt: "2026-01-01T10:02:00Z",
  toolreaderVersion: "0.1.0",
  session: "codex:native-1",
  thread,
  repo: { name: "o/r", worktree: `${HOME}/r`, branch: "main", head: "abc123" },
  labels: { e1: `label ${TOKEN}`, gone: "x" },
  turnMeta: [
    {
      promptId: "u1",
      model: "gpt-5.6",
      usage: { input: 100, cachedInput: 80, output: 7, reasoning: 0, total: 107 },
      startedAt: "2026-01-01T09:59:59Z",
      endedAt: "2026-01-01T10:00:40Z",
    },
  ],
  outputs: true,
  maxOutput: 8192,
  home: HOME,
};

const decode = Schema.decodeUnknownExit(Schema.fromJsonString(Checkpoint));
const encode = Schema.encodeSync(Schema.fromJsonString(Checkpoint));

describe("checkpoint", () => {
  it("redacts every free-text field and writes home as ~", () => {
    const cp = buildCheckpoint({
      ...base,
      trigger: "commit",
      commit: { commit, role: "coder", via: "trailer", reviewedSha: null, paths: ["src/a.ts"] },
      segment: entries,
    });
    const text = JSON.stringify(cp);
    assert.notInclude(text, TOKEN);
    assert.notInclude(text, HOME);
    assert.strictEqual(cp.thread.title, "fix [redacted]");
    assert.strictEqual(cp.commit?.subject, "fix with [redacted]");
    assert.strictEqual(cp.labels.e1, "label [redacted]");
    assert.isAtLeast(cp.redactions, 4);
  });

  it("redacts the metadata too: repo, branch, model, origin, session, commit paths", () => {
    const cp = buildCheckpoint({
      ...base,
      session: `codex:${TOKEN}`,
      thread: { ...thread, title: "t", origin: `${HOME}/bin/codex ${TOKEN}` },
      labels: {},
      repo: { name: `o/${TOKEN}`, worktree: null, branch: `fix/${TOKEN}`, head: "abc123" },
      turnMeta: [{ ...base.turnMeta[0]!, model: `m-${TOKEN}` }],
      trigger: "commit",
      commit: {
        commit,
        role: "coder",
        via: "trailer",
        reviewedSha: null,
        paths: [`src/${TOKEN}.ts`, "src/a.ts"],
      },
      segment: entries,
    });
    assert.notInclude(JSON.stringify(cp), TOKEN);
    assert.notInclude(JSON.stringify(cp), HOME);
    assert.deepStrictEqual(cp.commit?.paths, ["src/[redacted].ts", "src/a.ts"]);
    // Every replacement counts, the model's included.
    const modelOnly = buildCheckpoint({
      ...base,
      session: null,
      thread: { ...thread, title: "t" },
      labels: {},
      turnMeta: [{ ...base.turnMeta[0]!, model: `m-${TOKEN}` }],
      trigger: "manual",
      commit: null,
      segment: [user("u1", "2026-01-01T10:00:00Z", "go"), entries[1]!],
    });
    assert.strictEqual(modelOnly.redactions, 1);
  });

  it("keeps only the labels of entries it holds", () => {
    const cp = buildCheckpoint({ ...base, trigger: "manual", commit: null, segment: entries });
    assert.deepStrictEqual(Object.keys(cp.labels), ["e1"]);
  });

  it("summarizes turns: phases, stats, and what the reader knew", () => {
    const cp = buildCheckpoint({ ...base, trigger: "manual", commit: null, segment: entries });
    assert.deepStrictEqual(
      cp.turns.map((t) => [t.id, t.model, t.usage?.total ?? null, t.startedAt, t.phases]),
      [
        [
          "u1",
          "gpt-5.6",
          107,
          "2026-01-01T09:59:59Z",
          [
            { phase: "explore", actionIds: ["r1"] },
            { phase: "edit", actionIds: ["e1"] },
            { phase: "verify", actionIds: ["t1"] },
          ],
        ],
        [
          "u2",
          null,
          null,
          "2026-01-01T10:01:00Z",
          [
            { phase: "edit", actionIds: ["e2"] },
            { phase: "ship", actionIds: ["c1"] },
          ],
        ],
      ],
    );
    assert.deepStrictEqual(cp.turns[0]?.stats, {
      actions: 3,
      failed: 0,
      files: 1,
      added: 3,
      removed: 1,
    });
    assert.deepStrictEqual(cp.filesTouched, [{ path: "src/a.ts", added: 4, removed: 1 }]);
    assert.strictEqual(cp.durationMs, 80_000);
  });

  it("keys the same moment of the same thread the same way", () => {
    const manual = buildCheckpoint({ ...base, trigger: "manual", commit: null, segment: entries });
    // Named by its native id or its T3 thread, the session is one thread: the key uses the thread.
    assert.strictEqual(
      buildCheckpoint({ ...base, session: null, trigger: "manual", commit: null, segment: entries })
        .id,
      manual.id,
    );
    assert.strictEqual(
      checkpointKey({
        trigger: "commit",
        threadId: "t3-thread",
        repo: "o/r",
        commit: { sha: "abc123", role: "reviewer" },
        entries,
      }),
      "commit:o/r:abc123:t3-thread:reviewer",
    );
    assert.strictEqual(
      buildCheckpoint({ ...base, trigger: "manual", commit: null, segment: entries }).id,
      "manual:t3-thread:c1",
    );
  });

  it("round-trips through JSON and refuses a format it doesn't know", () => {
    const cp = buildCheckpoint({ ...base, trigger: "manual", commit: null, segment: entries });
    const back = decode(encode(cp));
    assert.isTrue(Exit.isSuccess(back));
    // What Postgres keeps is the JSON: keys the redactor left `undefined` are gone.
    if (Exit.isSuccess(back)) assert.deepStrictEqual(back.value, JSON.parse(JSON.stringify(cp)));
    assert.isTrue(Exit.isFailure(decode(JSON.stringify({ ...cp, formatVersion: 2 }))));
  });

  it("maps commit checkpoints to the entry ledger sync builds", () => {
    const found = {
      thread,
      role: "coder" as const,
      via: "trailer" as const,
      reviewedSha: null,
      segment: entries,
      labels: base.labels,
    };
    const expected = buildEntry({
      commit,
      links: [found],
      paths: ["src/a.ts", "README.md"],
      outputs: true,
      maxOutput: 8192,
      home: HOME,
    });
    const cp = buildCheckpoint({
      ...base,
      trigger: "commit",
      commit: {
        commit,
        role: "coder",
        via: "trailer",
        reviewedSha: null,
        paths: ["src/a.ts", "README.md"],
      },
      segment: entries,
    });
    const target = { commit, paths: ["src/a.ts", "README.md"] };
    assert.deepStrictEqual(toLedgerEntry(target, [cp]), expected);
    // Found through a rewrite: the older SHA's links count for the commit asked for, once each.
    const older = buildCheckpoint({
      ...base,
      thread: { ...thread, id: "reviewer" },
      trigger: "commit",
      commit: {
        commit: { ...commit, sha: "old111", subject: "old" },
        role: "reviewer",
        via: "asserted",
        reviewedSha: "old111",
        paths: ["src/a.ts"],
      },
      segment: entries,
    });
    const merged = toLedgerEntry(target, [cp, older, cp]);
    assert.deepStrictEqual(
      [merged.commit.sha, merged.links.map((l) => [l.thread.id, l.role, l.reviewedSha])],
      [
        "abc123",
        [
          ["t3-thread", "coder", null],
          ["reviewer", "reviewer", "old111"],
        ],
      ],
    );
    // A path with a secret in it: still attributed, and redacted in the entry too.
    const secretPath = `src/${TOKEN}.ts`;
    const edited = buildCheckpoint({
      ...base,
      trigger: "commit",
      commit: { commit, role: "coder", via: "sha", reviewedSha: null, paths: [secretPath] },
      segment: [
        action("w", "2026-01-01T10:00:20Z", "edit", {
          files: [{ path: secretPath, added: 1, removed: 0, isNew: false, isDeleted: false }],
        }),
      ],
    });
    assert.deepStrictEqual(toLedgerEntry({ commit, paths: [secretPath] }, [edited]).files, [
      { path: "src/[redacted].ts", bucket: "attributed" },
    ]);
    const manual = buildCheckpoint({ ...base, trigger: "manual", commit: null, segment: entries });
    assert.deepStrictEqual(toLedgerEntry(target, [manual]).links, []);
  });

  // Stored payloads, one per formatVersion, as the toolreader that wrote them wrote them: each
  // must keep reading after every change. Never regenerate one.
  it("reads every stored format, and refuses a newer one by name", () => {
    const read = Result.getOrThrow(readCheckpoint(v1));
    assert.strictEqual(read.id, "commit:acme/widgets:abc123:t3-thread:coder");
    assert.strictEqual(read.turns[0]?.usage?.total, 1290);
    // What the database's generated columns read: a stable contract.
    assert.deepStrictEqual(
      [
        read.trigger,
        read.thread.id,
        read.session,
        read.repo.name,
        read.commit?.sha,
        read.commit?.patchId,
      ],
      ["commit", "t3-thread", "codex:019a-native", "acme/widgets", "abc123", "p1"],
    );
    // A field a newer toolreader added without a new format is ignored.
    assert.isTrue(Result.isSuccess(readCheckpoint({ ...v1, addedLater: { x: 1 } })));
    assert.deepStrictEqual(
      readCheckpoint({ ...v1, formatVersion: 2, entries: "a v2 shape" }),
      Result.fail(
        "checkpoint format v2 is newer than this toolreader reads (v1): upgrade toolreader",
      ),
    );
    const broken = readCheckpoint({ ...v1, turns: "nope" });
    assert.isTrue(Result.isFailure(broken) && broken.failure.startsWith("not a checkpoint: "));
  });
});

describe("admitCheckpoint", () => {
  const reject = (record: unknown) => {
    const r = admitCheckpoint(record);
    return Result.isFailure(r) ? r.failure : null;
  };

  it("admits what buildCheckpoint builds, secrets and all", () => {
    for (const trigger of ["commit", "manual"] as const) {
      const cp = buildCheckpoint({
        ...base,
        trigger,
        commit:
          trigger === "commit"
            ? { commit, role: "coder", via: "trailer", reviewedSha: null, paths: ["src/a.ts"] }
            : null,
        segment: [
          ...entries,
          action("x1", "2026-01-01T10:01:30Z", "run", {
            output: `API_TOKEN=abc password: "p" https://u:pw@host Authorization: Bearer abc.def`,
          }),
        ],
      });
      const admitted = admitCheckpoint(JSON.parse(encode(cp)));
      assert.deepStrictEqual(
        Result.isSuccess(admitted) && admitted.success,
        JSON.parse(encode(cp)),
      );
    }
    assert.isTrue(Result.isSuccess(admitCheckpoint(v1)));
  });

  it("admits an output clipped inside a placeholder", () => {
    // Redacted, the output is `a…a API_TOKEN=[redacted] b…b`; keeping 60 bytes of head cuts at `[reda`.
    const cp = buildCheckpoint({
      ...base,
      trigger: "manual",
      commit: null,
      maxOutput: 120,
      segment: [
        user("u1", "2026-01-01T10:00:00Z"),
        action("x1", "2026-01-01T10:00:10Z", "run", {
          output: `${"a".repeat(44)} API_TOKEN=supersecretvalue ${"b".repeat(100)}`,
        }),
      ],
    });
    const output = cp.entries.flatMap((e) => (e.type === "action" ? [e.output] : []))[0];
    assert.include(output, "API_TOKEN=[redacted]");
    assert.notInclude(output, "supersecret");
    assert.isTrue(Result.isSuccess(admitCheckpoint(JSON.parse(encode(cp)))));
  });

  it("redacts a 2 MB string built to backtrack in linear time", () => {
    // Each once took seconds at 200 KB: the backend checks every string it is sent.
    for (const unit of [
      "TOKEN",
      "a.",
      "-----BEGIN RSA PRIVATE KEY-----",
      'SECRET="',
      "x://a:b",
      "eyJ-",
      "eyJaaaaaaaaaaaa.",
      "sk-",
      "glpat-",
      "xoxb-",
      "authorization: bearer ",
      '"token":"',
      "?token=",
    ]) {
      const started = performance.now();
      redactText(unit.repeat(Math.ceil(2_000_000 / unit.length)));
      assert.isBelow(performance.now() - started, 1000, unit);
    }
  });

  it("redacts JWTs wherever the old pattern did, a long header after a `-` included", () => {
    const jwt = (header: string) => `${header}.${"b".repeat(20)}.${"c".repeat(20)}`;
    for (const [text, want] of [
      [`Bearer ${jwt("eyJhbGciOiJSUzI1NiJ9")}`, "Bearer [redacted jwt]"],
      [`jwt-${jwt(`eyJ${"A".repeat(3000)}`)}`, "jwt-[redacted jwt]"],
      [`x.${jwt("eyJhbGciOiJSUzI1NiJ9")}.tail`, "x.[redacted jwt].tail"],
      [`a_${jwt("eyJhbGciOiJSUzI1NiJ9")}`, `a_${jwt("eyJhbGciOiJSUzI1NiJ9")}`],
      [`eyJ.short.${"c".repeat(20)}`, `eyJ.short.${"c".repeat(20)}`],
    ])
      assert.strictEqual(redactText(text!).text, want);
  });

  it("redacts the backend's own tokens, and refuses records that hold one", () => {
    const backendToken = `trk_${"A1b2_C3d-".repeat(5)}`;
    const cp = buildCheckpoint({
      ...base,
      trigger: "manual",
      commit: null,
      segment: [user("u1", "2026-01-01T10:00:00Z", `export TR=${backendToken}`)],
    });
    assert.notInclude(JSON.stringify(cp), backendToken);
    const raw = {
      ...v1,
      entries: v1.entries.map((e, i) => (i === 0 ? { ...e, text: backendToken } : e)),
    };
    assert.strictEqual(reject(raw)?.reason, "not-redacted");
  });

  it("rejects each problem by name, quoting no record text", () => {
    assert.deepStrictEqual(reject({ ...v1, formatVersion: 2 }), {
      reason: "unsupported-format",
      detail: "checkpoint format v2; this backend takes v1",
    });
    assert.strictEqual(reject({ id: "x" })?.reason, "invalid");
    assert.deepStrictEqual(reject({ ...v1, turns: "secret words" }), {
      reason: "invalid",
      detail: "not a checkpoint v1 at turns",
    });
    assert.strictEqual(reject({ ...v1, commit: null })?.reason, "invalid");
    assert.strictEqual(reject({ ...v1, id: "commit:other" })?.reason, "key-mismatch");
    const leaked = reject({
      ...v1,
      entries: v1.entries.map((e, i) => (i === 2 ? { ...e, output: `token ${TOKEN}` } : e)),
    });
    assert.deepStrictEqual(leaked, {
      reason: "not-redacted",
      detail: "the redactor would change entries.2.output",
    });
    // A label keyed by a secret: rejected, and the detail doesn't quote the key.
    const keyed = reject({ ...v1, labels: { [TOKEN]: "x" } });
    assert.deepStrictEqual(keyed, {
      reason: "not-redacted",
      detail: "the redactor would change labels.*",
    });
    assert.deepStrictEqual(reject({ ...v1, labels: { [TOKEN]: 1 } }), {
      reason: "invalid",
      detail: "not a checkpoint v1 at labels.*",
    });
    assert.strictEqual(
      reject({ ...v1, repo: { ...v1.repo, name: "o/".padEnd(513, "r") } })?.reason,
      "invalid",
    );
    assert.deepStrictEqual(reject({ ...v1, redactions: Infinity }), {
      reason: "invalid",
      detail: "not a finite number at redactions",
    });
    const nul = `t\u0000x`;
    const withNul = {
      ...v1,
      thread: { ...v1.thread, id: nul },
      id: v1.id.replace("t3-thread", nul),
    };
    assert.deepStrictEqual(reject(withNul), {
      reason: "invalid",
      detail: "id holds a NUL character",
    });
    // A label id spelled like a field name is still a label id.
    assert.deepStrictEqual(reject({ ...v1, labels: { privatename: 1 } }), {
      reason: "invalid",
      detail: "not a checkpoint v1 at labels.*",
    });
    // Postgres would refuse it, failing the whole batch.
    for (const takenAt of [
      "not-a-timestamp",
      "now",
      "2026-02-30T10:00:00Z",
      "0000-01-01T00:00:00Z",
      "2026-01-01T24:00:00Z",
      "2026-01-01T10:00:00+16:00",
    ])
      assert.deepStrictEqual(reject({ ...v1, takenAt }), {
        reason: "invalid",
        detail: "takenAt is not an ISO 8601 time",
      });
    for (const takenAt of ["2024-02-29T23:59:59.123456Z", "2026-10-01T12:00:00+05:30"])
      assert.isNull(reject({ ...v1, takenAt }), takenAt);
  });
});
