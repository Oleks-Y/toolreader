import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { Entry } from "../../core/domain.ts";
import type { CommitRecord, ThreadRecord } from "../../core/historyRecord.ts";
import { threadSha } from "../recordHash.ts";
import { HistoryStore } from "./HistoryStore.ts";
import { PgMigrationsLive } from "./PgMigrations.ts";
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

export const threadRecord = (id: string, entries: Entry[]): ThreadRecord => ({
  formatVersion: 1,
  thread: { id, title: "Add a", source: "codex", provider: "codex", origin: null, parent: null },
  takenAt: "2026-01-01T11:00:00.000Z",
  toolreaderVersion: "0.1.0",
  entries,
  labels: {},
  redactions: 0,
});

export const commitRecord = (sha: string, threadIds: string[]): CommitRecord => ({
  formatVersion: 1,
  repo: "acme/app",
  sha,
  subject: "feat: a",
  committedAt: "2026-01-01T12:00:00.000Z",
  novel: 4,
  explained: 3,
  links: threadIds.map((threadId) => ({ threadId, turns: ["u1"], via: "content", lines: 3 })),
  linkedAt: "2026-01-01T12:01:00.000Z",
  toolreaderVersion: "0.1.0",
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
  });
});
