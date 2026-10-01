import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { Action, Entry, ThreadSummary, ThreadView } from "../core/domain.ts";
import { CodexSessions } from "./CodexSessions.ts";
import { Labeler } from "./Labeler.ts";
import { Ledger } from "./Ledger.ts";
import { ServerConfig } from "./ServerConfig.ts";
import { ThreadStore } from "./ThreadStore.ts";

/** Runs git with fixed identity and dates, so commits line up with the fake session's actions. */
const git = (repo: string, args: ReadonlyArray<string>, date?: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const env: Record<string, string> = {
      GIT_AUTHOR_NAME: "Agent",
      GIT_AUTHOR_EMAIL: "agent@example.test",
      GIT_COMMITTER_NAME: "Agent",
      GIT_COMMITTER_EMAIL: "agent@example.test",
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
    };
    const handle = yield* spawner.spawn(
      ChildProcess.make("git", ["-C", repo, ...args], { env, extendEnv: true }),
    );
    const [out] = yield* Effect.all([
      handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      handle.exitCode,
    ]);
    return out.trim();
  }).pipe(Effect.scoped);

const action = (id: string, at: string, command: string, output?: string): Action => ({
  type: "action",
  id,
  at,
  kind: "git",
  status: "ok",
  title: command,
  command,
  ...(output ? { output } : {}),
});

describe("Ledger", () => {
  it.live(
    "syncs agent commits onto the ledger branch and reads a range back, even after an amend",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repo = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "toolreader-ledger-test-" }),
        );
        const commitFile = (name: string, content: string, message: string, date: string) =>
          Effect.gen(function* () {
            yield* fs.writeFileString(path.join(repo, name), content);
            yield* git(repo, ["add", name]);
            yield* git(repo, ["commit", "-q", "-m", message], date);
            return yield* git(repo, ["rev-parse", "HEAD"]);
          });

        yield* git(repo, ["init", "-q", "-b", "main"]);
        // The service's own git calls (commit-tree) need an identity; CI has none globally.
        yield* git(repo, ["config", "user.name", "Agent"]);
        yield* git(repo, ["config", "user.email", "agent@example.test"]);
        yield* commitFile("README.md", "hi\n", "init", "2026-01-01T09:00:00Z");
        yield* git(repo, ["switch", "-q", "-c", "feat/x"]);
        const first = yield* commitFile(
          "a.ts",
          "export const a = 1;\n",
          "feat: a",
          "2026-01-01T10:02:20Z",
        );
        const second = yield* commitFile(
          "b.ts",
          "export const b = 2;\n",
          "feat: b",
          "2026-01-01T10:05:03Z",
        );
        const human = yield* commitFile(
          "c.ts",
          "export const c = 3;\n",
          "chore: by hand",
          "2026-01-01T15:00:00Z",
        );

        // The session that made the first two commits: one quiet commit (time match), one printing its SHA.
        const entries: Entry[] = [
          {
            type: "message",
            id: "u1",
            at: "2026-01-01T10:00:00Z",
            role: "user",
            text: "add a and b",
          },
          action("e1", "2026-01-01T10:01:00Z", "cat > a.ts <<EOF"),
          action("c1", "2026-01-01T10:02:00Z", "git add -A && git commit -q -m 'feat: a'"),
          action(
            "e2",
            "2026-01-01T10:03:00Z",
            "cat > b.ts <<EOF",
            "token=ghp_0123456789abcdefghijABCDEFGHIJ012345",
          ),
          action(
            "c2",
            "2026-01-01T10:05:00Z",
            "git commit -m 'feat: b'",
            `[feat/x ${second.slice(0, 7)}] feat: b`,
          ),
        ];
        const summary: ThreadSummary = {
          id: "t1",
          source: "t3",
          origin: null,
          title: "Add a and b",
          projectId: "p",
          projectTitle: "repo",
          provider: "claudeAgent",
          status: "idle",
          archived: false,
          updatedAt: "2026-01-01T10:06:00Z",
          actionCount: 4,
          worktree: repo,
        };
        const view: ThreadView = {
          thread: { ...summary, head: "h" },
          entries,
          labels: { c2: "Committed b" },
        };

        const layer = Ledger.layer.pipe(
          Layer.provide([
            Layer.succeed(
              ServerConfig,
              ServerConfig.of({
                port: 0,
                home: "/home/me",
                dbPath: "",
                codexBin: "codex",
                labelsPath: "",
                distDir: "",
              }),
            ),
            Layer.succeed(
              ThreadStore,
              ThreadStore.of({
                list: Effect.succeed([summary]),
                get: () => Effect.succeed(view),
                head: () => Effect.die("unused"),
                codexThreadIds: Effect.succeed(new Set()),
                projects: Effect.succeed([]),
              }),
            ),
            Layer.succeed(
              CodexSessions,
              CodexSessions.of({
                list: Effect.succeed([]),
                get: () => Effect.die("unused"),
                head: () => Effect.die("unused"),
                ready: Effect.void,
              }),
            ),
            Layer.succeed(
              Labeler,
              Labeler.of({
                forThread: () => Effect.succeed({ c2: "Committed b" }),
                label: () => Effect.die("unused"),
              }),
            ),
          ]),
        );

        yield* Effect.gen(function* () {
          const ledger = yield* Ledger;
          const result = yield* ledger.sync(repo, null, true);
          assert.strictEqual(result.range, "main..HEAD");
          assert.deepStrictEqual(
            result.added.map((a) => [a.commit.subject, a.match, a.actions]),
            [
              ["feat: a", "time", 2],
              ["feat: b", "sha", 2],
            ],
          );
          assert.deepStrictEqual(
            result.unmatched.map((c) => c.sha),
            [human],
          );

          // Plumbing only: the code branch and working tree are untouched.
          assert.strictEqual(yield* git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "feat/x");
          assert.strictEqual(yield* git(repo, ["status", "--porcelain"]), "");
          const files = (yield* git(repo, ["ls-tree", "-r", "--name-only", "agent-ledger"])).split(
            "\n",
          );
          assert.deepStrictEqual(
            files.sort(),
            [`commits/${first}.json`, `commits/${second}.json`, "patch-ids.json"].sort(),
          );
          assert.include(
            yield* git(repo, ["show", `agent-ledger:commits/${second}.json`]),
            "token=[redacted]",
          );

          // A second sync finds nothing new.
          const again = yield* ledger.sync(repo, null, true);
          assert.strictEqual(again.added.length, 0);
          assert.strictEqual(again.existing, 2);

          // Amend keeps the diff: the entry is found again by patch-id.
          yield* git(
            repo,
            ["commit", "-q", "--amend", "-m", "chore: by hand (reworded)"],
            "2026-01-01T16:00:00Z",
          );
          yield* git(repo, ["switch", "-q", "--detach", second]);
          yield* git(
            repo,
            ["commit", "-q", "--amend", "-m", "feat: b (reworded)"],
            "2026-01-01T16:00:00Z",
          );
          const range = yield* ledger.range(repo, "main..HEAD");
          assert.deepStrictEqual(
            range.commits.map((c) => [
              c.commit.subject,
              c.matchedBy,
              c.entry?.entries.map((e) => e.id),
            ]),
            [
              ["feat: a", "sha", ["u1", "e1", "c1"]],
              ["feat: b (reworded)", "patch-id", ["u1", "e2", "c2"]],
            ],
          );
          assert.deepStrictEqual(range.commits[1]?.entry?.labels, { c2: "Committed b" });
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
