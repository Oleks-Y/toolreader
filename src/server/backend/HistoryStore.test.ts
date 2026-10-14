import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

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
      }),
    );
  });
});
