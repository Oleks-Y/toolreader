import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { hunkKey } from "../../core/blame.ts";
import type { Entry } from "../../core/domain.ts";
import { PgClient } from "@effect/sql-pg/PgClient";
import { threadSha } from "../recordHash.ts";
import { HistoryStore } from "./HistoryStore.ts";
import { PgMigrationsLive } from "./PgMigrations.ts";
import { commitRecord, threadRecord } from "./testRecords.ts";
import { inWorkspace, PgTestLive } from "./testPostgres.ts";

const TestLive = HistoryStore.layer.pipe(
  Layer.provideMerge(PgMigrationsLive),
  Layer.provideMerge(PgTestLive),
  Layer.provide(NodeServices.layer),
);

const message = (id: string, text: string): Entry => ({
  type: "message",
  id,
  at: "2026-01-01T10:00:00.000Z",
  role: "user",
  text,
});

describe("HistoryStore", () => {
  it.layer(TestLive, { timeout: 120_000 })((it) => {
    it.effect("keeps a thread once, replaced only when its history changed", () =>
      Effect.gen(function* () {
        const store = yield* inWorkspace("threads");
        const first = threadRecord("t1", [message("u1", "Add a")]);
        assert.strictEqual(yield* store.putThread(first), "inserted");
        // Read again later by a newer toolreader: same history, nothing to write.
        assert.strictEqual(
          yield* store.putThread({
            ...first,
            takenAt: "2026-01-02T00:00:00.000Z",
            toolreaderVersion: "0.2.0",
          }),
          "same",
        );
        const grown = threadRecord("t1", [message("u1", "Add a"), message("u2", "Now b")]);
        assert.strictEqual(yield* store.putThread(grown), "updated");
        assert.deepStrictEqual(
          yield* store.hashes(["t1", "nope"]),
          new Map([["t1", threadSha(grown)]]),
        );
        assert.deepStrictEqual(
          (yield* store.threads(["t1"])).map((t) => t.entries.length),
          [2],
        );
      }),
    );

    it.effect("stores text jsonb can't hold, as U+FFFD", () =>
      Effect.gen(function* () {
        const store = yield* inWorkspace("nul");
        yield* store.putThread(threadRecord("bin", [message("u1", "a\u0000b \ud800")]));
        const [stored] = yield* store.threads(["bin"]);
        assert.strictEqual((stored!.entries[0] as { text: string }).text, "a�b �");
      }),
    );

    it.effect("replaces a commit's links, and keeps workspaces apart", () =>
      Effect.gen(function* () {
        const ours = yield* inWorkspace("ours");
        const theirs = yield* inWorkspace("theirs");
        assert.strictEqual(yield* ours.putCommit(commitRecord("abc1234", ["t1"])), "inserted");
        assert.strictEqual(yield* ours.putCommit(commitRecord("abc1234", ["t1"])), "same");
        // Linked again after a split: what it says now is what holds.
        assert.strictEqual(yield* ours.putCommit(commitRecord("abc1234", ["t2"])), "updated");
        assert.deepStrictEqual(
          (yield* ours.commits("acme/app", ["abc1234", "other"])).map((c) =>
            c.links.map((l) => l.threadId),
          ),
          [["t2"]],
        );
        assert.deepStrictEqual(yield* theirs.commits("acme/app", ["abc1234"]), []);
        yield* ours.putThread(threadRecord("t2", [message("u1", "x")]));
        assert.deepStrictEqual(yield* theirs.threads(["t2"]), []);
      }),
    );

    it.effect("lists repos and pages a repo's ledger newest first, linked commits only", () =>
      Effect.gen(function* () {
        const store = yield* inWorkspace("ledger");
        const at = (sha: string, minute: number, threads: string[]) => ({
          ...commitRecord(sha, threads),
          committedAt: `2026-01-01T12:${String(minute).padStart(2, "0")}:00.000Z`,
        });
        yield* store.putCommit(at("aaa0001", 2, ["t1"]));
        yield* store.putCommit(at("aaa0002", 2, ["t1", "t2"]));
        yield* store.putCommit(at("aaa0003", 2, ["t3"]));
        yield* store.putCommit(at("aaa0004", 4, []));
        yield* store.putCommit({ ...at("bbb0001", 9, ["t9"]), repo: "acme/other" });
        assert.deepStrictEqual(
          (yield* store.repos()).map((r) => [r.repo, r.commits, r.threads]),
          [
            ["acme/other", 1, 1],
            ["acme/app", 3, 3],
          ],
        );
        const first = yield* store.ledger("acme/app", null, 1);
        assert.deepStrictEqual(
          first.map((c) => c.sha),
          ["aaa0003"],
        );
        assert.deepStrictEqual(
          (yield* store.ledger("acme/app", first.at(-1)!.sha, 1)).map((c) => c.sha),
          ["aaa0002"],
        );
      }),
    );

    it.effect("replaces stale blame evidence for a hunk and model", () =>
      Effect.gen(function* () {
        const store = yield* inWorkspace("blames");
        const blame = {
          repo: "acme/app",
          sha: "abc1234",
          path: "src/x.ts",
          hunk: { header: "@@ -1 +1,2 @@", text: "+a\n+b" },
          threadIds: ["t1"],
          pieces: [
            {
              id: "A01",
              threadId: "t1",
              actionId: "e1",
              odds: { wrote: 0.9, staged: 0, checked: 0.1, unrelated: 0 },
            },
          ],
          main: { id: "A01", p: 0.9 },
          model: "jev-1.13.0",
          inputTokens: 100,
        };
        const key = hunkKey("src/x.ts", "@@ -1 +1,2 @@");
        assert.isTrue(Option.isNone(yield* store.blame("acme/app", "abc1234", key, "jev-1.13.0")));
        yield* store.putBlame(blame);
        yield* store.putBlame({ ...blame, main: { id: "none", p: 1 } });
        const stored = Option.getOrThrow(
          yield* store.blame("acme/app", "abc1234", key, "jev-1.13.0"),
        );
        assert.deepStrictEqual(stored.main, { id: "none", p: 1 });
        assert.isTrue(Option.isNone(yield* store.blame("acme/app", "abc1234", key, "jev-2")));
      }),
    );

    it.effect("finds a token's workspace by its hash, and nothing for another", () =>
      Effect.gen(function* () {
        const store = yield* HistoryStore;
        const token = yield* store.createToken("team", "ci");
        const caller = Option.getOrThrow(yield* store.authenticate(token));
        assert.strictEqual(caller.workspace, "team");
        assert.isTrue(Option.isNone(yield* store.authenticate(`${token}x`)));
      }),
    );

    it.effect("finds commands, outputs and paths in a repo's threads, citing each", () =>
      Effect.gen(function* () {
        const store = yield* inWorkspace("search");
        const run = (id: string, at: string, extra: Partial<Entry>): Entry =>
          ({
            type: "action",
            id,
            at,
            kind: "test",
            status: "failed",
            title: "vitest run",
            command: "vitest run",
            ...extra,
          }) as Entry;
        yield* store.putThread(
          threadRecord("t1", [
            message("u1", "fix the flaky retry test"),
            run("a1", "2026-01-01T10:01:00.000Z", { output: "TypeError: retries is undefined" }),
            run("a2", "2026-01-01T10:02:00.000Z", {
              kind: "edit",
              status: "ok",
              title: "edit src/retry.ts",
              command: undefined,
              files: [
                { path: "src/retry.ts", added: 1, removed: 0, isNew: false, isDeleted: false },
              ],
            }),
            run("a3", "2026-01-01T10:03:00.000Z", { output: "coverage 100% of lines" }),
          ]),
        );
        // Another repo's thread, and one no commit links.
        yield* store.putThread(
          threadRecord("t2", [run("b1", "2026-01-01T11:00:00.000Z", { output: "retries ok" })]),
        );
        yield* store.putCommit(commitRecord("abc1234", ["t1"]));
        yield* store.putCommit({ ...commitRecord("def5678", ["t2"]), repo: "acme/other" });

        const find = (text: string, repo?: string, limit = 20) =>
          store.search({ text, repo, limit });
        const hit = (yield* find("RETRIES IS", "acme/app")).hits;
        assert.deepStrictEqual(
          hit.map((h) => [h.threadId, h.entryId, h.kind, h.status, h.snippet]),
          [["t1", "a1", "test", "failed", "TypeError: retries is undefined"]],
        );
        // Cited at the version found: the thread's stored content hash.
        assert.strictEqual(hit[0]!.version, (yield* store.hashes(["t1"])).get("t1"));
        // A path, newest first across the workspace, and a message's text.
        assert.deepStrictEqual(
          (yield* find("retr")).hits.map((h) => h.entryId),
          ["b1", "a2", "a1", "u1"],
        );
        assert.deepStrictEqual(
          (yield* find("retr", "acme/app")).hits.map((h) => h.entryId),
          ["a2", "a1", "u1"],
        );
        // `%` and `_` match themselves, not anything.
        assert.deepStrictEqual(
          (yield* find("100%")).hits.map((h) => h.entryId),
          ["a3"],
        );
        assert.deepStrictEqual((yield* find("1_0")).hits, []);
        const page = yield* find("retr", undefined, 2);
        assert.deepStrictEqual([page.hits.length, page.truncated], [2, true]);
        // One commit's threads (by SHA prefix), actions of some kinds, and no text at all.
        const ids = (q: Parameters<typeof store.search>[0]) =>
          store.search(q).pipe(Effect.map((r) => r.hits.map((h) => h.entryId)));
        assert.deepStrictEqual(yield* ids({ text: "retr", commit: "def5", limit: 20 }), ["b1"]);
        assert.deepStrictEqual(
          yield* ids({ text: "retr", commit: "def5", repo: "acme/app", limit: 20 }),
          [],
        );
        assert.deepStrictEqual(yield* ids({ kinds: ["edit"], limit: 20 }), ["a2"]);
        assert.deepStrictEqual(yield* ids({ commit: "abc1234", kinds: ["test"], limit: 20 }), [
          "a3",
          "a1",
        ]);
        const listed = (yield* store.search({ commit: "abc1234", limit: 20 })).hits;
        assert.deepStrictEqual(
          listed.map((h) => [h.entryId, h.snippet]),
          [
            ["a3", "coverage 100% of lines"],
            ["a2", "src/retry.ts"],
            ["a1", "TypeError: retries is undefined"],
            ["u1", "fix the flaky retry test"],
          ],
        );
      }),
    );

    it.effect("reads a citation back, or says why not; removal reaches search", () =>
      Effect.gen(function* () {
        const hs = yield* HistoryStore;
        const ws = yield* hs.workspace("evidence");
        const store = hs.at({ workspaceId: ws, tokenId: null, client: "0.1.0" });
        const v1 = threadRecord("t1", [message("u1", "retries is undefined")]);
        yield* store.putThread(v1);
        yield* store.putCommit(commitRecord("abc1234", ["t1"]));
        const version = threadSha(v1);
        const cite = { threadId: "t1", entryId: "u1" };
        assert.strictEqual((yield* store.evidence({ ...cite, version })).status, "ok");
        assert.strictEqual(
          (yield* store.evidence({ ...cite, version: version.slice(0, 12) })).entry?.id,
          "u1",
        );
        assert.strictEqual(
          (yield* store.evidence({ ...cite, repo: "acme/other" })).status,
          "withheld",
        );
        assert.strictEqual(
          (yield* store.evidence({ threadId: "nope", entryId: "u1" })).status,
          "missing",
        );
        // Replaced since: the old citation doesn't show the new text as if it were the old one.
        yield* store.putThread(threadRecord("t1", [message("u1", "now something else")]));
        const replaced = yield* store.evidence({ ...cite, version });
        assert.deepStrictEqual(
          [replaced.status, replaced.entry],
          ["version-unavailable", undefined],
        );

        assert.isTrue(yield* hs.deleteThread("evidence", "t1"));
        assert.strictEqual((yield* store.evidence(cite)).status, "deleted");
        assert.deepStrictEqual((yield* store.search({ text: "something", limit: 5 })).hits, []);
        // The next sync sends it again: not stored.
        assert.strictEqual(
          yield* store.putThread(threadRecord("t1", [message("u1", "again")])),
          "same",
        );
        assert.deepStrictEqual(yield* store.threads(["t1"]), []);
      }),
    );

    it.effect("expires only threads stored longer ago than the retention period", () =>
      Effect.gen(function* () {
        const hs = yield* HistoryStore;
        const ws = yield* hs.workspace("retention");
        const store = hs.at({ workspaceId: ws, tokenId: null, client: "0.1.0" });
        yield* store.putThread(threadRecord("old", [message("u1", "a")]));
        yield* store.putThread(threadRecord("new", [message("u1", "b")]));
        const sql = yield* PgClient;
        yield* sql`UPDATE threads SET uploaded_at = now() - interval '40 days'
                   WHERE workspace_id = ${ws} AND id = 'old'`;
        assert.strictEqual(yield* hs.expire(30), 1);
        assert.strictEqual(
          (yield* store.evidence({ threadId: "old", entryId: "u1" })).status,
          "expired",
        );
        assert.strictEqual(
          (yield* store.evidence({ threadId: "new", entryId: "u1" })).status,
          "ok",
        );
        // The same version sent again stays expired; a changed one is stored.
        assert.strictEqual(
          yield* store.putThread(threadRecord("old", [message("u1", "a")])),
          "same",
        );
        assert.strictEqual(
          yield* store.putThread(threadRecord("old", [message("u1", "a2")])),
          "inserted",
        );
      }),
    );

    it.effect("a revoked token stops working at once", () =>
      Effect.gen(function* () {
        const hs = yield* HistoryStore;
        const token = yield* hs.createToken("revoke", "laptop");
        assert.isTrue(Option.isSome(yield* hs.authenticate(token)));
        assert.strictEqual(yield* hs.revokeToken("revoke", "laptop"), 1);
        assert.isTrue(Option.isNone(yield* hs.authenticate(token)));
      }),
    );
  });
});
