import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { Action, Entry, ThreadSummary, ThreadView } from "../core/domain.ts";
import { LedgerEntry } from "../core/ledger.ts";
import { CodexRollouts } from "./CodexRollouts.ts";
import { CodexSessions } from "./CodexSessions.ts";
import { Labeler } from "./Labeler.ts";
import { Ledger } from "./Ledger.ts";
import { ServerConfig } from "./ServerConfig.ts";
import { ThreadStore } from "./ThreadStore.ts";
import * as Schema from "effect/Schema";

const decodeEntry = Schema.decodeUnknownSync(Schema.fromJsonString(LedgerEntry));

/** Runs git with fixed identity and dates, so commits line up with the fake sessions' actions. */
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

const tempDir = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix }));
  });

/** A repo on `main` with one commit, an identity (the service's commit-tree needs one; CI has none) and a bare origin. */
const makeRepo = Effect.gen(function* () {
  const path = yield* Path.Path;
  const repo = yield* tempDir("toolreader-ledger-test-");
  const origin = path.join(yield* tempDir("toolreader-ledger-origin-"), "origin.git");
  yield* git(repo, ["init", "-q", "-b", "main"]);
  yield* git(repo, ["config", "user.name", "Agent"]);
  yield* git(repo, ["config", "user.email", "agent@example.test"]);
  yield* git(repo, ["init", "-q", "--bare", origin]);
  yield* git(repo, ["remote", "add", "origin", origin]);
  const commitFile = (name: string, content: string, message: string, date: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(path.join(repo, name), content);
      yield* git(repo, ["add", name]);
      yield* git(repo, ["commit", "-q", "-m", message], date);
      return yield* git(repo, ["rev-parse", "HEAD"]);
    });
  yield* commitFile("README.md", "hi\n", "init", "2026-01-01T09:00:00Z");
  return { repo, origin, commitFile };
});

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

/** A `codex exec` rollout file, as Codex writes it, in `codexHome`. */
const writeRollout = (
  codexHome: string,
  id: string,
  cwd: string,
  items: ReadonlyArray<{ at: string; item: object }>,
  source: unknown = "exec",
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(codexHome, "sessions", "2026", "01", "01");
    yield* fs.makeDirectory(dir, { recursive: true });
    const first = items[0]?.at ?? "2026-01-01T00:00:00.000Z";
    const line = (timestamp: string, type: string, payload: object) =>
      JSON.stringify({ timestamp, type, payload });
    const lines = [
      line(first, "session_meta", { id, timestamp: first, cwd, originator: "codex_exec", source }),
      line(first, "event_msg", { type: "task_started", turn_id: `${id}-t1` }),
      ...items.map(({ at, item }) =>
        line(at, "event_msg", { type: "item_completed", turn_id: `${id}-t1`, item }),
      ),
      line(items.at(-1)?.at ?? first, "event_msg", { type: "task_complete", turn_id: `${id}-t1` }),
    ];
    yield* fs.writeFileString(
      path.join(dir, `rollout-2026-01-01T00-00-00-${id}.jsonl`),
      lines.join("\n"),
    );
  });
const userMessage = (id: string, text: string) => ({
  type: "UserMessage",
  id,
  content: [{ type: "text", text }],
});
const command = (id: string, script: string, output = "", exitCode = 0) => ({
  type: "CommandExecution",
  id,
  command: ["/bin/zsh", "-lc", script],
  cwd: "/repo",
  status: "completed",
  aggregated_output: output,
  exit_code: exitCode,
});

/**
 * Ledger over fakes for T3 (`t3`: the threads its database holds, or none when `dbPath` is
 * missing) and labels, with the real rollout reader over `codexHome`.
 */
const ledgerLayer = (options: {
  dbPath: string;
  codexHome: string;
  t3?: ReadonlyArray<ThreadView>;
  labels?: Record<string, string>;
}) =>
  Ledger.layer.pipe(
    Layer.provide(CodexRollouts.layer),
    Layer.provide([
      Layer.succeed(
        ServerConfig,
        ServerConfig.of({
          port: 0,
          home: "/home/me",
          dbPath: options.dbPath,
          codexBin: "codex",
          codexHome: options.codexHome,
          labelsPath: "",
          distDir: "",
        }),
      ),
      options.t3
        ? Layer.succeed(
            ThreadStore,
            ThreadStore.of({
              list: Effect.succeed(options.t3.map((v) => v.thread)),
              get: (id) => Effect.succeed(options.t3!.find((v) => v.thread.id === id)!),
              head: () => Effect.die("unused"),
              codexThreadIds: Effect.succeed(new Set(["owned-by-t3"])),
              projects: Effect.succeed([]),
            }),
          )
        : ThreadStore.empty,
      CodexSessions.disabled,
      Layer.succeed(
        Labeler,
        Labeler.of({
          forThread: () => Effect.succeed(options.labels ?? {}),
          label: () => Effect.die("unused"),
        }),
      ),
    ]),
  );

describe("Ledger", () => {
  it.live(
    "syncs agent commits onto the ledger branch and reads a range back, even after an amend",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { repo, commitFile } = yield* makeRepo;
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
        const dbPath = path.join(yield* tempDir("toolreader-t3-"), "state.sqlite");
        yield* fs.writeFileString(dbPath, "");
        // T3 ran this Codex session itself: its rollout must not count twice (it would match by SHA).
        const codexHome = yield* tempDir("toolreader-codex-home-");
        yield* writeRollout(codexHome, "owned-by-t3", repo, [
          {
            at: "2026-01-01T10:02:00.000Z",
            item: command("x", "git commit -m 'feat: a'", `[feat/x ${first.slice(0, 7)}] feat: a`),
          },
        ]);

        yield* Effect.gen(function* () {
          const ledger = yield* Ledger;
          const result = yield* ledger.sync(repo, null);
          assert.strictEqual(result.range, "main..HEAD");
          assert.deepStrictEqual(result.sources, ["t3", "codex-rollouts"]);
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
          const again = yield* ledger.sync(repo, null, { source: "t3" });
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
        }).pipe(
          Effect.provide(
            ledgerLayer({
              dbPath,
              codexHome,
              t3: [{ thread: { ...summary, head: "h" }, entries, labels: { c2: "Committed b" } }],
              labels: { c2: "Committed b" },
            }),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "works headless from Codex rollout files: no T3, a commit a later step made, clipped outputs",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const { repo, commitFile } = yield* makeRepo;
        const codexHome = yield* tempDir("toolreader-codex-home-");
        yield* git(repo, ["switch", "-q", "-c", "feat/x"]);
        const byAgent = yield* commitFile("a.ts", "a\n", "feat: a", "2026-01-01T10:02:30Z");
        const byCi = yield* commitFile("b.ts", "b\n", "feat: b", "2026-01-01T10:30:00Z");

        // Session 1 commits itself and prints the SHA.
        yield* writeRollout(codexHome, "s1", repo, [
          { at: "2026-01-01T10:00:00.000Z", item: userMessage("u1", "Add a\nmore detail") },
          { at: "2026-01-01T10:01:00.000Z", item: command("c1", "printf 'a\\n' > a.ts") },
          {
            at: "2026-01-01T10:02:00.000Z",
            item: command(
              "c2",
              "git add a.ts && git commit -m 'feat: a'",
              `[feat/x ${byAgent.slice(0, 7)}] feat: a\n`,
            ),
          },
        ]);
        // Session 2 only edits (the sandbox blocks .git); CI commits after it ends.
        yield* writeRollout(codexHome, "s2", path.join(repo, "sub"), [
          { at: "2026-01-01T10:10:00.000Z", item: userMessage("u2", "Add b") },
          { at: "2026-01-01T10:11:00.000Z", item: command("c3", "cat big.log", "x".repeat(5000)) },
          { at: "2026-01-01T10:20:00.000Z", item: command("c4", "printf 'b\\n' > b.ts") },
        ]);
        // Neither counts: a subagent in the repo, and a session elsewhere.
        yield* writeRollout(
          codexHome,
          "child",
          repo,
          [{ at: "2026-01-01T10:25:00.000Z", item: command("c5", "ls") }],
          { subagent: { other: "guardian" } },
        );
        yield* writeRollout(codexHome, "other", "/elsewhere", [
          { at: "2026-01-01T10:25:00.000Z", item: command("c6", "ls") },
        ]);

        yield* Effect.gen(function* () {
          const ledger = yield* Ledger;
          const result = yield* ledger.sync(repo, null, { maxOutput: 1000 });
          assert.deepStrictEqual(result.sources, ["codex-rollouts"]);
          assert.deepStrictEqual(
            result.added.map((a) => [a.commit.sha, a.thread, a.match, a.actions]),
            [
              [byAgent, "Add a", "sha", 2],
              [byCi, "Add b", "session", 2],
            ],
          );
          const entry = decodeEntry(
            yield* git(repo, ["show", `agent-ledger:commits/${byCi}.json`]),
          );
          assert.strictEqual(entry.thread.id, "codex:s2");
          assert.deepStrictEqual(
            entry.entries.map((e) => e.id),
            ["u2", "c3", "c4"],
          );
          const big = entry.entries.find((e) => e.id === "c3");
          // normalize keeps 1500 + 1500 characters already; the ledger clips what is left.
          const clipped = big?.type === "action" ? (big.clipped ?? 0) : 0;
          assert.isAbove(clipped, 0);
          assert.include(big?.type === "action" ? big.output : "", `[${clipped} bytes clipped]`);

          // Asking for a source that isn't there is an error; auto just skips it.
          const missing = yield* Effect.flip(ledger.sync(repo, null, { source: "t3" }));
          assert.include(missing.message, "No T3 database");
        }).pipe(Effect.provide(ledgerLayer({ dbPath: "/nonexistent/state.sqlite", codexHome })));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("--push writes on top of origin's ledger and retries when another push lands first", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { repo, origin, commitFile } = yield* makeRepo;
      const codexHome = yield* tempDir("toolreader-codex-home-");
      yield* git(repo, ["push", "-q", "origin", "main"]);
      yield* git(repo, ["switch", "-q", "-c", "feat/x"]);
      const agentCommit = (n: number, minute: number) =>
        Effect.gen(function* () {
          const sha = yield* commitFile(
            `f${n}.ts`,
            `${n}\n`,
            `feat: ${n}`,
            `2026-01-01T10:${minute}:30Z`,
          );
          yield* writeRollout(codexHome, `s${n}`, repo, [
            { at: `2026-01-01T10:${minute - 1}:00.000Z`, item: userMessage(`u${n}`, `Add ${n}`) },
            {
              at: `2026-01-01T10:${minute}:00.000Z`,
              item: command(
                `c${n}`,
                `git commit -m 'feat: ${n}'`,
                `[feat/x ${sha.slice(0, 7)}] feat: ${n}\n`,
              ),
            },
          ]);
          return sha;
        });
      const remoteLedger = () =>
        git(repo, ["ls-remote", "origin", "refs/heads/agent-ledger"]).pipe(
          Effect.map((l) => l.split(/\s/)[0] ?? ""),
        );
      const remoteFiles = () => git(origin, ["ls-tree", "-r", "--name-only", "agent-ledger"]);

      yield* Effect.gen(function* () {
        const ledger = yield* Ledger;
        const one = yield* agentCommit(1, 10);
        const first = yield* ledger.sync(repo, null, { push: true });
        assert.deepStrictEqual(
          first.added.map((a) => a.commit.sha),
          [one],
        );
        assert.strictEqual(first.pushed, yield* remoteLedger());
        assert.strictEqual(yield* git(repo, ["rev-parse", "agent-ledger"]), first.pushed);
        assert.strictEqual(yield* git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "feat/x");
        assert.strictEqual(yield* git(repo, ["status", "--porcelain"]), "");

        // Another job's ledger commit, on top of the first one, waiting in origin.
        const other = yield* tempDir("toolreader-ledger-other-");
        yield* git(other, ["clone", "-q", "--branch", "agent-ledger", origin, "."]);
        yield* fs.makeDirectory(path.join(other, "commits"), { recursive: true });
        yield* fs.writeFileString(path.join(other, "commits", "f".repeat(40) + ".json"), "{}\n");
        yield* git(other, ["add", "-A"]);
        yield* git(other, ["commit", "-q", "-m", "ledger: other job"]);
        const theirs = yield* git(other, ["rev-parse", "HEAD"]);
        yield* git(other, ["push", "-q", "origin", "HEAD:refs/heads/scratch"]);
        // It lands while our push is in flight: origin moves agent-ledger to it once, mid-push.
        const hook = path.join(origin, "hooks", "pre-receive");
        yield* fs.writeFileString(
          hook,
          `#!/bin/sh\n[ -f raced ] && exit 0\ntouch raced\nenv -u GIT_QUARANTINE_PATH git update-ref refs/heads/agent-ledger ${theirs}\n`,
        );
        yield* fs.chmod(hook, 0o755);

        const two = yield* agentCommit(2, 20);
        const second = yield* ledger.sync(repo, null, { push: true });
        assert.deepStrictEqual(
          second.added.map((a) => a.commit.sha),
          [two],
        );
        assert.isTrue(yield* fs.exists(path.join(origin, "raced")), "the race happened");
        const tip = yield* remoteLedger();
        assert.strictEqual(second.pushed, tip);
        assert.strictEqual(yield* git(repo, ["rev-parse", "agent-ledger"]), tip);
        assert.strictEqual(
          yield* git(repo, ["rev-parse", `${tip}^`]),
          theirs,
          "rebuilt on their tip",
        );
        assert.deepStrictEqual(
          (yield* remoteFiles()).split("\n").sort(),
          [
            `commits/${"f".repeat(40)}.json`,
            `commits/${one}.json`,
            `commits/${two}.json`,
            "patch-ids.json",
          ].sort(),
        );
        assert.strictEqual(yield* git(repo, ["status", "--porcelain"]), "");

        // Nothing new: nothing pushed.
        const third = yield* ledger.sync(repo, null, { push: true });
        assert.deepStrictEqual([third.added.length, third.pushed], [0, null]);
      }).pipe(Effect.provide(ledgerLayer({ dbPath: "/nonexistent/state.sqlite", codexHome })));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "installs a pre-push hook idempotently, never over someone else's, and it syncs what is pushed",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { repo, commitFile } = yield* makeRepo;
        const dir = yield* tempDir("toolreader-hook-");
        // Stands in for the toolreader CLI: records its arguments.
        const log = path.join(dir, "calls.log");
        const fake = path.join(dir, "toolreader.sh");
        yield* fs.writeFileString(fake, `#!/bin/sh\necho "$@" >> '${log}'\n`);
        yield* fs.chmod(fake, 0o755);
        const hookFile = path.join(repo, ".git", "hooks", "pre-push");

        yield* Effect.gen(function* () {
          const ledger = yield* Ledger;
          assert.match(yield* ledger.hook(repo, "install", `'${fake}'`), /^Installed /);
          assert.match(yield* ledger.hook(repo, "install", `'${fake}'`), /^Already installed/);
          assert.strictEqual(((yield* fs.stat(hookFile)).mode & 0o111) !== 0, true);

          const main = yield* git(repo, ["rev-parse", "HEAD"]);
          yield* git(repo, ["push", "-q", "origin", "main"]);
          const next = yield* commitFile("a.ts", "a\n", "feat: a", "2026-01-01T10:00:00Z");
          yield* git(repo, ["push", "-q", "origin", "main"]);
          yield* git(repo, ["push", "-q", "origin", "main:refs/heads/agent-ledger"]);
          assert.deepStrictEqual((yield* fs.readFileString(log)).trim().split("\n"), [
            `sync --repo ${repo} --range ${main} --not --remotes=origin --push`,
            `sync --repo ${repo} --range ${main}..${next} --push`,
          ]);

          assert.strictEqual(yield* ledger.hook(repo, "uninstall", ""), `Removed ${hookFile}.`);
          yield* fs.writeFileString(hookFile, "#!/bin/sh\nexit 0\n");
          const refused = yield* Effect.flip(ledger.hook(repo, "install", `'${fake}'`));
          assert.include(refused.message, "not toolreader's");
          assert.include(refused.message, "--push");
          assert.strictEqual(yield* fs.readFileString(hookFile), "#!/bin/sh\nexit 0\n");
          yield* Effect.flip(ledger.hook(repo, "uninstall", ""));
          assert.isTrue(yield* fs.exists(hookFile));
        }).pipe(
          Effect.provide(
            ledgerLayer({ dbPath: "/nonexistent/state.sqlite", codexHome: "/nonexistent" }),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "keeps a secret in the first prompt line out of the whole entry, title and labels too",
    () =>
      Effect.gen(function* () {
        const { repo, commitFile } = yield* makeRepo;
        const codexHome = yield* tempDir("toolreader-codex-home-");
        yield* git(repo, ["switch", "-q", "-c", "feat/x"]);
        const sha = yield* commitFile("a.ts", "a\n", "feat: a", "2026-01-01T10:02:30Z");
        yield* writeRollout(codexHome, "s1", repo, [
          {
            at: "2026-01-01T10:00:00.000Z",
            item: userMessage("u1", "Use API_TOKEN=supersecret to fix this"),
          },
          {
            at: "2026-01-01T10:02:00.000Z",
            item: command("c1", "git commit -m 'feat: a'", `[feat/x ${sha.slice(0, 7)}] feat: a\n`),
          },
        ]);
        yield* Effect.gen(function* () {
          const ledger = yield* Ledger;
          const result = yield* ledger.sync(repo, null, { outputs: false });
          assert.deepStrictEqual(
            result.added.map((a) => a.commit.sha),
            [sha],
          );
          const json = yield* git(repo, ["show", `agent-ledger:commits/${sha}.json`]);
          assert.notInclude(json, "supersecret");
          assert.include(decodeEntry(json).thread.title, "API_TOKEN=[redacted]");
          assert.notInclude(result.added[0]!.thread, "supersecret", "nor in what sync prints");
        }).pipe(
          Effect.provide(
            ledgerLayer({
              dbPath: "/nonexistent/state.sqlite",
              codexHome,
              labels: { c1: "Commit with API_TOKEN=supersecret" },
            }),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
