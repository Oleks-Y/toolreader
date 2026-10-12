import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { buildCheckpoint, type Checkpoint } from "../../core/checkpoint.ts";
import type { Entry } from "../../core/domain.ts";
import { CheckpointStore } from "./CheckpointStore.ts";
import { migrate, PgMigrationsLive } from "./PgMigrations.ts";
import { inWorkspace, PgTestLive } from "./testPostgres.ts";

const TestLive = CheckpointStore.layer.pipe(
  Layer.provideMerge(PgMigrationsLive),
  Layer.provideMerge(PgTestLive),
  Layer.provide(NodeServices.layer),
);

const entries: Entry[] = [
  { type: "message", id: "u1", at: "2026-01-01T10:00:00Z", role: "user", text: "fix it" },
  {
    type: "action",
    id: "c1",
    at: "2026-01-01T10:01:00Z",
    kind: "git",
    status: "ok",
    title: "git commit",
    command: "git commit -m fix",
  },
];
const checkpoint = (
  threadId: string,
  commit: { sha: string; patchId: string | null } | null,
  text = "fix it",
): Checkpoint =>
  buildCheckpoint({
    trigger: commit ? "commit" : "manual",
    takenAt: "2026-01-01T10:02:00Z",
    toolreaderVersion: "0.1.0",
    session: `codex:${threadId}`,
    thread: {
      id: threadId,
      title: "t",
      source: "codex",
      provider: "codex",
      origin: null,
      parent: null,
    },
    repo: { name: "o/r", worktree: null, branch: null, head: null },
    commit: commit && {
      commit: { ...commit, subject: "fix", committedAt: "2026-01-01T10:01:05Z" },
      role: "coder",
      via: "trailer",
      reviewedSha: null,
      paths: ["a.ts"],
    },
    segment: entries.map((e): Entry => (e.type === "message" ? { ...e, text } : e)),
    labels: {},
    turnMeta: [],
    outputs: true,
    maxOutput: 0,
  });

describe("CheckpointStore", () => {
  it.layer(TestLive, { timeout: 120_000 })((it) => {
    it.effect("migrates once", () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* migrate(), []);
      }),
    );

    it.effect("stores a checkpoint once, and replaces it only when its content changed", () =>
      Effect.gen(function* () {
        const store = yield* inWorkspace("test");
        const cp = checkpoint("put", null);
        assert.strictEqual(yield* store.put(cp), "inserted");
        assert.strictEqual(yield* store.put(cp), "exists");
        assert.strictEqual(yield* store.put(cp, { replace: true }), "exists");
        // Taken again later, by a newer toolreader: the same content.
        const retaken = { ...cp, takenAt: "2030-01-01T00:00:00.000Z", toolreaderVersion: "9.9.9" };
        assert.strictEqual(yield* store.put(retaken, { replace: true }), "exists");
        // Asked for by another name, after the repo moved on: still the same history.
        const moved = {
          ...cp,
          session: "codex:other-name",
          repo: { ...cp.repo, branch: "next", head: "f00" },
        };
        assert.strictEqual(yield* store.put(moved), "exists");
        // Labels in another order: the same content.
        const labelled = { ...cp, labels: { b: "2", a: "1" } };
        assert.strictEqual(yield* store.put(labelled, { replace: true }), "replaced");
        assert.strictEqual(yield* store.put({ ...cp, labels: { a: "1", b: "2" } }), "exists");
        const changed = checkpoint("put", null, "fix it properly");
        assert.strictEqual(changed.id, cp.id);
        // Other content under the same id is kept, and said so, until --replace.
        assert.strictEqual(yield* store.put(changed), "differs");
        assert.strictEqual(yield* store.put(changed, { replace: true }), "replaced");
        const back = Option.getOrThrow(yield* store.get(cp.id));
        assert.deepStrictEqual(back.entries[0], {
          type: "message",
          id: "u1",
          at: "2026-01-01T10:00:00Z",
          role: "user",
          text: "fix it properly",
        });
        assert.isTrue(Option.isNone(yield* store.get("nope")));
      }),
    );

    it.effect("refuses a commit checkpoint with no commit", () =>
      Effect.gen(function* () {
        const store = yield* inWorkspace("test");
        const broken = { ...checkpoint("broken", null), trigger: "commit" as const };
        const error = yield* Effect.flip(store.put(broken));
        assert.strictEqual(error._tag, "CheckpointRefused");
        assert.isTrue(Option.isNone(yield* store.get(broken.id)));
      }),
    );

    it.effect("tells data Postgres refuses from a failure worth retrying", () =>
      Effect.gen(function* () {
        const store = yield* inWorkspace("test");
        const refused = { ...checkpoint("feb30", null), takenAt: "2026-02-30T10:00:00Z" };
        const error = yield* Effect.flip(store.put(refused));
        assert.deepStrictEqual(
          [error._tag, error.message],
          ["CheckpointRefused", "Postgres refused the record's data"],
        );
        // An id past the btree's row size (54000), random so TOAST can't shrink it.
        const long = checkpoint(NodeCrypto.randomBytes(2400).toString("hex"), null);
        assert.strictEqual((yield* Effect.flip(store.put(long)))._tag, "CheckpointRefused");
      }),
    );

    it.effect("finds a commit's checkpoints by SHA, by rewrite, and by patch-id", () =>
      Effect.gen(function* () {
        const store = yield* inWorkspace("test");
        yield* store.put(checkpoint("coder", { sha: "aaa", patchId: "p1" }));
        yield* store.put(checkpoint("amended", { sha: "bbb", patchId: "p2" }));
        const found = (sha: string, patchId: string | null) =>
          store
            .forCommit("o/r", sha, patchId)
            .pipe(Effect.map((r) => r.map((c) => [c.checkpoint.thread.id, c.matched])));
        assert.deepStrictEqual(yield* found("aaa", "p1"), [["coder", "sha"]]);
        // A rebase that kept the diff: same patch-id, new SHA.
        assert.deepStrictEqual(yield* found("ccc", "p1"), [["coder", "patch-id"]]);
        // An amend that changed the diff: only the recorded rewrite finds it.
        assert.deepStrictEqual(yield* found("ddd", "p9"), []);
        assert.strictEqual(yield* store.rewrite("o/r", [{ oldSha: "bbb", newSha: "ddd" }]), 1);
        assert.strictEqual(yield* store.rewrite("o/r", [{ oldSha: "bbb", newSha: "ddd" }]), 0);
        assert.strictEqual(yield* store.rewrite("o/r", [{ oldSha: "ddd", newSha: "ddd" }]), 0);
        assert.deepStrictEqual(yield* found("ddd", "p9"), [["amended", "rewrite"]]);
        assert.deepStrictEqual(yield* found("ddd", null), [["amended", "rewrite"]]);
        // Amended again, then rebased: the walk goes back through every rewrite, and a cycle ends.
        yield* store.rewrite("o/r", [
          { oldSha: "ddd", newSha: "ggg" },
          { oldSha: "ggg", newSha: "hhh" },
          { oldSha: "hhh", newSha: "ddd" },
        ]);
        assert.deepStrictEqual(yield* found("hhh", null), [["amended", "rewrite"]]);
        assert.deepStrictEqual(yield* store.forCommit("other/repo", "aaa", "p1"), []);
        // A cycle walked to the depth limit still lists each checkpoint once, every one of them.
        yield* store.put(checkpoint("cycled", { sha: "eee", patchId: "p7" }));
        yield* store.put(checkpoint("also", { sha: "fff", patchId: "p7" }));
        yield* store.put(checkpoint("patched", { sha: "abc", patchId: "p7" }));
        yield* store.rewrite("o/r", [
          { oldSha: "eee", newSha: "fff" },
          { oldSha: "fff", newSha: "eee" },
        ]);
        assert.deepStrictEqual(yield* found("eee", "p7"), [
          ["cycled", "sha"],
          ["also", "rewrite"],
          ["patched", "patch-id"],
        ]);
      }),
    );

    it.effect("stores text holding NUL or half an emoji, which jsonb refuses as is", () =>
      Effect.gen(function* () {
        const store = yield* inWorkspace("test");
        const cp = checkpoint("nul", null, "binary \u0000 cut \ud83d ok \u{1F600} literal \\u0000");
        assert.strictEqual(yield* store.put(cp), "inserted");
        const back = Option.getOrThrow(yield* store.get(cp.id));
        assert.strictEqual(
          back.entries[0]?.type === "message" ? back.entries[0].text : "",
          "binary \ufffd cut \ufffd ok \u{1F600} literal \\u0000",
        );
        assert.strictEqual(yield* store.put(cp), "exists");
      }),
    );

    it.effect("lists a thread's checkpoints, and fills the columns from the payload", () =>
      Effect.gen(function* () {
        const store = yield* inWorkspace("test");
        const sql = yield* SqlClient.SqlClient;
        const cp = checkpoint("listed", { sha: "eee", patchId: null });
        yield* store.put(cp);
        assert.deepStrictEqual(
          (yield* store.forThread("listed")).map((c) => c.id),
          [cp.id],
        );
        const rows = yield* sql`
          SELECT trigger, thread_id, session, repo, commit_sha, patch_id
          FROM checkpoints WHERE id = ${cp.id}`;
        assert.deepStrictEqual(rows, [
          {
            trigger: "commit",
            thread_id: "listed",
            session: "codex:listed",
            repo: "o/r",
            commit_sha: "eee",
            patch_id: null,
          },
        ]);
      }),
    );

    it.effect("keeps each workspace's checkpoints and rewrites to itself", () =>
      Effect.gen(function* () {
        const a = yield* inWorkspace("iso-a");
        const b = yield* inWorkspace("iso-b");
        const cp = checkpoint("isolated", { sha: "iii", patchId: "pi" });
        assert.strictEqual(yield* a.put(cp), "inserted");
        assert.isTrue(Option.isNone(yield* b.get(cp.id)));
        assert.deepStrictEqual(yield* b.forThread("isolated"), []);
        assert.deepStrictEqual(yield* b.forCommit("o/r", "iii", "pi"), []);
        // The same id in another workspace is its own record.
        assert.strictEqual(yield* b.put(cp), "inserted");
        assert.strictEqual(yield* b.rewrite("o/r", [{ oldSha: "iii", newSha: "jjj" }]), 1);
        assert.deepStrictEqual(yield* a.forCommit("o/r", "jjj", null), []);
        assert.strictEqual((yield* b.forCommit("o/r", "jjj", null))[0]?.matched, "rewrite");
      }),
    );

    it.effect("authenticates a live token by its hash alone", () =>
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        const sql = yield* SqlClient.SqlClient;
        const token = yield* store.createToken("tokens", "alex laptop");
        assert.match(token, /^trk_[A-Za-z0-9_-]{43}$/);
        const caller = Option.getOrThrow(yield* store.authenticate(token));
        assert.strictEqual(caller.workspace, "tokens");
        assert.strictEqual(caller.workspaceId, yield* store.workspace("tokens"));
        assert.isTrue(Option.isNone(yield* store.authenticate(`${token}x`)));
        const rows = yield* sql<{ stored: number }>`
          SELECT count(*)::int AS stored FROM api_tokens
          WHERE token_sha256 = ${token} OR name = ${token}`;
        assert.strictEqual(rows[0]?.stored, 0);
        yield* sql`UPDATE api_tokens SET revoked_at = now() WHERE id = ${caller.tokenId}`;
        assert.isTrue(Option.isNone(yield* store.authenticate(token)));
      }),
    );
  });
});
