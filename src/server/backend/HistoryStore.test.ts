import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { hunkKey } from "../../core/blame.ts";
import type { Entry } from "../../core/domain.ts";
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
        yield* store.putCommit(at("aaa0001", 1, ["t1"]));
        yield* store.putCommit(at("aaa0002", 2, ["t1", "t2"]));
        yield* store.putCommit(at("aaa0003", 3, ["t3"]));
        yield* store.putCommit(at("aaa0004", 4, []));
        yield* store.putCommit({ ...at("bbb0001", 9, ["t9"]), repo: "acme/other" });
        assert.deepStrictEqual(
          (yield* store.repos()).map((r) => [r.repo, r.commits, r.threads]),
          [
            ["acme/other", 1, 1],
            ["acme/app", 3, 3],
          ],
        );
        const first = yield* store.ledger("acme/app", null, 2);
        assert.deepStrictEqual(
          first.map((c) => c.sha),
          ["aaa0003", "aaa0002"],
        );
        assert.deepStrictEqual(
          (yield* store.ledger("acme/app", first.at(-1)!.committedAt, 2)).map((c) => c.sha),
          ["aaa0001"],
        );
      }),
    );

    it.effect("keeps the first blame for a hunk and model", () =>
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
        assert.deepStrictEqual(stored.main, { id: "A01", p: 0.9 });
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
  });
});
