import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { Action, Entry, ThreadSummary, ThreadView } from "../core/domain.ts";
import { LedgerEntry, LedgerRange } from "../core/ledger.ts";
import { SITE_DATA_MARKER } from "../core/ledgerSite.ts";
import { CodexRollouts } from "./CodexRollouts.ts";
import { CodexSessions } from "./CodexSessions.ts";
import { Labeler } from "./Labeler.ts";
import { Ledger } from "./Ledger.ts";
import { Sanitizer } from "./Sanitizer.ts";
import { ServerConfig } from "./ServerConfig.ts";
import { ThreadStore } from "./ThreadStore.ts";
import * as Schema from "effect/Schema";

const decodeEntry = Schema.decodeUnknownSync(Schema.fromJsonString(LedgerEntry));
const decodeRange = Schema.decodeUnknownSync(Schema.fromJsonString(LedgerRange));
const encodeRange = Schema.encodeSync(Schema.fromJsonString(LedgerRange));

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

/** Runs git with extra environment and returns its exit code too (for pushes a hook may reject). */
const gitRun = (repo: string, args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make("git", ["-C", repo, ...args], { env, extendEnv: true }),
    );
    const [out, err, code] = yield* Effect.all(
      [
        handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
        handle.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    return { out: out.trim(), err, code: Number(code) };
  }).pipe(Effect.scoped);

/** Runs the toolreader CLI from source, as the hook and the action do. */
const runCli = (args: ReadonlyArray<string>, env: Record<string, string>) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(process.execPath, [path.join(import.meta.dirname, "bin.ts"), ...args], {
        env,
        extendEnv: true,
      }),
    );
    const [out, err, code] = yield* Effect.all(
      [
        handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
        handle.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    return { out, err, code: Number(code) };
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
  folder = "sessions",
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(codexHome, folder, "2026", "01", "01");
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
    return path.join(dir, `rollout-2026-01-01T00-00-00-${id}.jsonl`);
  });
const userMessage = (id: string, text: string) => ({
  type: "UserMessage",
  id,
  content: [{ type: "text", text }],
});
const fileChange = (id: string, file: string) => ({
  type: "FileChange",
  id,
  changes: { [file]: { type: "add", content: "x\n" } },
  status: "completed",
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
  distDir?: string;
  sanitizer?: Layer.Layer<Sanitizer>;
  nativeIds?: ReadonlyArray<readonly [string, string]>;
  parents?: ReadonlyArray<readonly [string, string]>;
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
          userConfigPath: "",
          distDir: options.distDir ?? "",
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
              lineage: Effect.succeed({
                nativeIds: new Map(options.nativeIds ?? []),
                parents: new Map(options.parents ?? []),
              }),
              projects: Effect.succeed([]),
            }),
          )
        : ThreadStore.empty,
      CodexSessions.disabled,
      options.sanitizer ?? Sanitizer.off,
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
            result.added.map((a) => [a.commit.subject, a.links.map((l) => [l.via, l.actions])]),
            [
              ["feat: a", [["time", 2]]],
              ["feat: b", [["sha", 2]]],
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
            [
              `commits/${first}.json`,
              `commits/${second}.json`,
              `commits/${human}.json`,
              "patch-ids.json",
            ].sort(),
          );
          // The commit no thread made is recorded too, its file untracked.
          const byHand = decodeEntry(
            yield* git(repo, ["show", `agent-ledger:commits/${human}.json`]),
          );
          assert.deepStrictEqual(
            [byHand.links, byHand.files],
            [[], [{ path: "c.ts", bucket: "untracked" }]],
          );
          assert.include(
            yield* git(repo, ["show", `agent-ledger:commits/${second}.json`]),
            "token=[redacted]",
          );

          // A second sync finds nothing new.
          const again = yield* ledger.sync(repo, null, { source: "t3" });
          assert.strictEqual(again.added.length, 0);
          assert.strictEqual(again.existing, 3);
          const tip = yield* git(repo, ["rev-parse", "agent-ledger"]);
          yield* ledger.sync(repo, null, { source: "t3" });
          assert.strictEqual(yield* git(repo, ["rev-parse", "agent-ledger"]), tip, "no new commit");

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
              c.entry?.links[0]?.entries.map((e) => e.id),
            ]),
            [
              ["feat: a", "sha", ["u1", "e1", "c1"]],
              ["feat: b (reworded)", "patch-id", ["u1", "e2", "c2"]],
            ],
          );
          assert.deepStrictEqual(range.commits[1]?.entry?.links[0]?.labels, { c2: "Committed b" });
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
          const result = yield* ledger.sync(repo, null, { maxOutput: 1000, matchSessions: true });
          assert.deepStrictEqual(result.sources, ["codex-rollouts"]);
          assert.deepStrictEqual(
            result.added.flatMap((a) =>
              a.links.map((l) => [a.commit.sha, l.title, l.via, l.actions]),
            ),
            [
              [byAgent, "Add a", "sha", 2],
              [byCi, "Add b", "session", 2],
            ],
          );
          const entry = decodeEntry(yield* git(repo, ["show", `agent-ledger:commits/${byCi}.json`]))
            .links[0]!;
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

          assert.strictEqual(
            yield* ledger.hook(repo, "uninstall", `'${fake}'`),
            `Removed ${hookFile}.`,
          );
          yield* fs.writeFileString(hookFile, "#!/bin/sh\nexit 0\n");
          const refused = yield* Effect.flip(ledger.hook(repo, "install", `'${fake}'`));
          assert.include(refused.message, "not toolreader's");
          assert.include(refused.message, "--push");
          assert.strictEqual(yield* fs.readFileString(hookFile), "#!/bin/sh\nexit 0\n");
          yield* Effect.flip(ledger.hook(repo, "uninstall", `'${fake}'`));
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
          assert.include(decodeEntry(json).links[0]!.thread.title, "API_TOKEN=[redacted]");
          assert.notInclude(
            result.added[0]!.links[0]!.title,
            "supersecret",
            "nor in what sync prints",
          );
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

  it.live("publishes a range with every free-text field redacted and no local paths", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { repo, commitFile } = yield* makeRepo;
      const codexHome = yield* tempDir("toolreader-codex-home-");
      const distDir = yield* tempDir("toolreader-dist-");
      const out = path.join(yield* tempDir("toolreader-site-"), "pr", "7");
      yield* git(repo, ["switch", "-q", "-c", "feat/x"]);
      const sha = yield* commitFile(
        "a.ts",
        "a\n",
        "feat: a with API_TOKEN=subjectsecret",
        "2026-01-01T10:02:30Z",
      );
      yield* commitFile("b.ts", "b\n", "fix: API_TOKEN=humansecret", "2026-01-01T11:00:00Z");
      yield* writeRollout(codexHome, "s1", repo, [
        {
          at: "2026-01-01T10:00:00.000Z",
          item: userMessage("u1", "Use API_TOKEN=supersecret and keep </script> in text"),
        },
        {
          at: "2026-01-01T10:02:00.000Z",
          item: command("c1", "git commit -m 'feat: a'", `[feat/x ${sha.slice(0, 7)}] feat: a\n`),
        },
      ]);
      yield* Effect.gen(function* () {
        const ledger = yield* Ledger;
        const missing = yield* Effect.flip(ledger.site(repo, null, out));
        assert.include(missing.message, "No site template");
        yield* fs.makeDirectory(path.join(distDir, "site"));
        yield* fs.writeFileString(
          path.join(distDir, "site", "index.html"),
          `<html><body>${SITE_DATA_MARKER}<script>app()</script></body></html>`,
        );

        yield* ledger.sync(repo, null);
        const { file, view } = yield* ledger.site(repo, null, out);
        assert.strictEqual(file, path.join(out, "index.html"));
        const html = yield* fs.readFileString(file);
        for (const secret of ["supersecret", "subjectsecret", "humansecret"])
          assert.notInclude(html, secret);
        assert.notInclude(html, repo, "no absolute repo path");
        assert.notInclude(html, "</script> in text", "data can't close its script element");
        // One data element, before the app script that reads it.
        const match =
          /^<html><body><script type="application\/json" id="ledger-data">(.*)<\/script><script>app\(\)<\/script><\/body><\/html>$/s.exec(
            html,
          );
        assert.isNotNull(match);
        const inlined = decodeRange(match![1]!);
        assert.deepStrictEqual(inlined, decodeRange(encodeRange(view)));
        assert.strictEqual(inlined.range, "main..HEAD");
        const entry = inlined.commits.find((c) => c.commit.sha === sha)!.entry!;
        assert.include(
          entry.links[0]!.thread.title,
          "API_TOKEN=[redacted] and keep </script> in text",
        );
        assert.strictEqual(entry.commit.subject, "feat: a with API_TOKEN=[redacted]");
        assert.strictEqual(inlined.repo, path.basename(repo));
        assert.deepStrictEqual(
          inlined.commits.map((c) => c.commit.subject),
          ["feat: a with API_TOKEN=[redacted]", "fix: API_TOKEN=[redacted]"],
        );

        // `ledger show` (the action's job summary) prints the same public view.
        const show = yield* runCli(["ledger", "show", "--repo", repo], {
          T3_DB: "/nonexistent/state.sqlite",
          CODEX_HOME: codexHome,
        });
        assert.strictEqual(show.code, 0, show.err);
        for (const secret of ["supersecret", "subjectsecret", "humansecret"])
          assert.notInclude(show.out, secret);
        assert.notInclude(show.out, repo);
        assert.include(show.out, `${path.basename(repo)} main..HEAD`);
        assert.include(show.out, "fix: API_TOKEN=[redacted]");
      }).pipe(
        Effect.provide(ledgerLayer({ dbPath: "/nonexistent/state.sqlite", codexHome, distDir })),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "ties a commit to a session only when asked, only to one that edited here, never by guessing",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { repo, commitFile } = yield* makeRepo;
        const codexHome = yield* tempDir("toolreader-codex-home-");
        const elsewhere = path.join(yield* tempDir("toolreader-ledger-wt-"), "wt");
        yield* git(repo, ["worktree", "add", "-q", "-b", "other", elsewhere]);
        yield* git(repo, ["switch", "-q", "-c", "feat/x"]);
        // The editor ends, a read-only reviewer ends later, then CI commits (parent at 09:00).
        yield* writeRollout(codexHome, "editor", repo, [
          { at: "2026-01-01T09:30:00.000Z", item: userMessage("u1", "Edit e") },
          { at: "2026-01-01T10:00:00.000Z", item: fileChange("f1", path.join(repo, "e.ts")) },
        ]);
        const second = yield* writeRollout(codexHome, "editor2", repo, [
          { at: "2026-01-01T09:40:00.000Z", item: userMessage("u2", "Edit f") },
          { at: "2026-01-01T10:01:00.000Z", item: command("w2", "printf 'x' > f.ts") },
        ]);
        yield* writeRollout(codexHome, "reviewer", repo, [
          { at: "2026-01-01T10:02:00.000Z", item: userMessage("u3", "Review") },
          { at: "2026-01-01T10:04:00.000Z", item: command("d1", "git diff") },
        ]);
        // Edits in another worktree of the repo never count for this one.
        yield* writeRollout(codexHome, "elsewhere", elsewhere, [
          { at: "2026-01-01T10:02:00.000Z", item: userMessage("u4", "Other") },
          { at: "2026-01-01T10:03:00.000Z", item: fileChange("f4", path.join(elsewhere, "o.ts")) },
        ]);
        const ci = yield* commitFile("e.ts", "x\n", "chore: CI commit", "2026-01-01T10:05:00Z");

        yield* Effect.gen(function* () {
          const ledger = yield* Ledger;
          // By default only as evidence: the editor wrote e.ts, the file CI committed.
          const byDefault = yield* ledger.sync(repo, null);
          assert.deepStrictEqual(
            byDefault.added.flatMap((a) => a.links.map((l) => [a.commit.sha, l.via, l.title])),
            [[ci, "evidence", "Edit e"]],
          );

          const twoEditors = yield* ledger.sync(repo, null, { matchSessions: true });
          assert.deepStrictEqual(twoEditors.added.length, 0);
          assert.deepStrictEqual(
            twoEditors.ambiguous.map((a) => [a.commit.sha, [...a.sessions].sort()]),
            [[ci, ["codex:editor", "codex:editor2"]]],
          );

          yield* fs.remove(second);
          const oneEditor = yield* ledger.sync(repo, null, { matchSessions: true });
          assert.deepStrictEqual(
            oneEditor.added.flatMap((a) => a.links.map((l) => [a.commit.sha, l.via, l.title])),
            [[ci, "session", "Edit e"]],
          );

          // Read-only sessions never qualify on their own; naming one attributes it directly.
          yield* writeRollout(codexHome, "reviewer2", repo, [
            { at: "2026-01-01T10:10:00.000Z", item: userMessage("u5", "Review again") },
            { at: "2026-01-01T10:20:00.000Z", item: command("d2", "git diff") },
          ]);
          const ci2 = yield* commitFile("g.ts", "g\n", "chore: CI again", "2026-01-01T10:30:00Z");
          const readOnly = yield* ledger.sync(repo, null, { matchSessions: true });
          assert.deepStrictEqual(
            readOnly.unmatched.map((c) => c.sha),
            [ci2],
          );
          const unknown = yield* Effect.flip(ledger.sync(repo, null, { sessions: ["nope"] }));
          assert.include(unknown.message, "nope");
          const named = yield* ledger.sync(repo, null, { sessions: ["reviewer2"] });
          // ci2 was recorded with no thread; naming one adds it to that entry.
          assert.deepStrictEqual(
            named.added.flatMap((a) => a.links.map((l) => [a.commit.sha, l.via, l.title])),
            [[ci2, "session", "Review again"]],
          );
        }).pipe(Effect.provide(ledgerLayer({ dbPath: "/nonexistent/state.sqlite", codexHome })));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "writes entries as the sanitizer leaves them; sanitize rewrites the branch as one commit",
    () =>
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
        // Marks what it saw: the title says which mode it ran in.
        const fake = Layer.succeed(
          Sanitizer,
          Sanitizer.of({
            config: () => Effect.succeed({}),
            sanitize: (_, entries, choice) =>
              Effect.succeed({
                entries: entries.map((e) => ({
                  ...e,
                  links: e.links.map((l) => ({
                    ...l,
                    thread: { ...l.thread, title: `clean:${choice.mode}:${choice.agent}` },
                  })),
                })),
                mode: choice.mode ?? "anonymize",
                hits: entries.length,
                spans: choice.agent ? [] : null,
              }),
          }),
        );
        const titleOn = (ref: string, sha: string) =>
          git(repo, ["show", `${ref}:commits/${sha}.json`]).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(LedgerEntry))),
            Effect.map((e) => e.links[0]!.thread.title),
          );

        yield* Effect.gen(function* () {
          const ledger = yield* Ledger;
          const one = yield* agentCommit(1, 10);
          const first = yield* ledger.sync(repo, null, { push: true, sanitize: "remove" });
          assert.deepStrictEqual(first.sanitized, { mode: "remove", hits: 1, spans: null });
          assert.strictEqual(yield* titleOn("agent-ledger", one), "clean:remove:null");

          // An entry only origin has (another machine's), and one only this clone has.
          const other = yield* tempDir("toolreader-ledger-other-");
          yield* git(other, ["clone", "-q", "--branch", "agent-ledger", origin, "."]);
          const theirs = "e".repeat(40);
          const copy = yield* fs.readFileString(path.join(other, "commits", `${one}.json`));
          yield* fs.writeFileString(
            path.join(other, "commits", `${theirs}.json`),
            copy.replaceAll(one, theirs),
          );
          yield* git(other, ["add", "-A"]);
          yield* git(other, ["commit", "-q", "-m", "ledger: other machine"]);
          yield* git(other, ["push", "-q", "origin", "HEAD:agent-ledger"]);
          const two = yield* agentCommit(2, 20);
          yield* ledger.sync(repo, null);

          const result = yield* ledger.sanitize(repo, {
            mode: "anonymize",
            agent: true,
            push: true,
          });
          assert.deepStrictEqual(
            { entries: result.entries, mode: result.mode, hits: result.hits, spans: result.spans },
            { entries: 3, mode: "anonymize", hits: 3, spans: 0 },
          );
          const tip = (yield* git(repo, ["ls-remote", "origin", "refs/heads/agent-ledger"])).split(
            /\s/,
          )[0];
          assert.strictEqual(result.pushed, tip);
          assert.strictEqual(yield* git(repo, ["rev-parse", "agent-ledger"]), tip);
          assert.strictEqual(
            yield* git(repo, ["rev-list", "--count", "agent-ledger"]),
            "1",
            "no history",
          );
          for (const sha of [one, two, theirs])
            assert.strictEqual(yield* titleOn("agent-ledger", sha), "clean:anonymize:true");
          assert.include(yield* git(repo, ["show", "agent-ledger:patch-ids.json"]), two);
        }).pipe(
          Effect.provide(
            ledgerLayer({ dbPath: "/nonexistent/state.sqlite", codexHome, sanitizer: fake }),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("refuses to move agent-ledger while another worktree has it checked out", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { repo, origin, commitFile } = yield* makeRepo;
      const codexHome = yield* tempDir("toolreader-codex-home-");
      yield* git(repo, ["push", "-q", "origin", "main"]);
      yield* git(repo, ["switch", "-q", "-c", "feat/x"]);
      const sha = yield* commitFile("a.ts", "a\n", "feat: a", "2026-01-01T10:02:30Z");
      yield* writeRollout(codexHome, "s1", repo, [
        { at: "2026-01-01T10:01:00.000Z", item: userMessage("u1", "Add a") },
        {
          at: "2026-01-01T10:02:00.000Z",
          item: command("c1", "git commit -m 'feat: a'", `[feat/x ${sha.slice(0, 7)}] feat: a\n`),
        },
      ]);
      yield* Effect.gen(function* () {
        const ledger = yield* Ledger;
        const l0 = (yield* ledger.sync(repo, null, { push: true })).pushed;
        // Origin moves on to L1; here, a worktree has agent-ledger checked out at L0.
        const other = yield* tempDir("toolreader-ledger-other-");
        yield* git(other, ["clone", "-q", "--branch", "agent-ledger", origin, "."]);
        yield* fs.writeFileString(path.join(other, "commits", `${"e".repeat(40)}.json`), "{}\n");
        yield* git(other, ["add", "-A"]);
        yield* git(other, ["commit", "-q", "-m", "ledger: elsewhere"]);
        yield* git(other, ["push", "-q", "origin", "HEAD:agent-ledger"]);
        const wt = path.join(yield* tempDir("toolreader-ledger-wt-"), "ledger");
        yield* git(repo, ["worktree", "add", "-q", wt, "agent-ledger"]);

        const refused = yield* Effect.flip(ledger.sync(repo, null, { push: true }));
        assert.include(refused.message, "checked out");
        assert.strictEqual(yield* git(wt, ["rev-parse", "HEAD"]), l0);
        assert.strictEqual(yield* git(wt, ["status", "--porcelain"]), "");
      }).pipe(Effect.provide(ledgerLayer({ dbPath: "/nonexistent/state.sqlite", codexHome })));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("the hook lets an atomic push of code and agent-ledger through", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { repo, commitFile } = yield* makeRepo;
      const codexHome = yield* tempDir("toolreader-codex-home-");
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
                `[main ${sha.slice(0, 7)}] feat: ${n}\n`,
              ),
            },
          ]);
          return sha;
        });
      // The hook runs the real CLI, on this test's Codex home and no T3.
      const env = {
        CODEX_HOME: codexHome,
        T3_DB: "/nonexistent/state.sqlite",
        CODEX_BIN: "/nonexistent/codex",
        TOOLREADER_LABELS: path.join(codexHome, "labels.json"),
      };
      const cli = `'${process.execPath}' '${path.join(import.meta.dirname, "bin.ts")}' ledger`;

      yield* Effect.gen(function* () {
        const ledger = yield* Ledger;
        yield* agentCommit(1, 10);
        yield* git(repo, ["push", "-q", "origin", "main"]);
        yield* ledger.sync(repo, "HEAD~1..HEAD", { push: true }); // origin: L0
        yield* agentCommit(2, 20);
        yield* ledger.sync(repo, "HEAD~1..HEAD"); // local: L1
        const l1 = yield* git(repo, ["rev-parse", "agent-ledger"]);
        const three = yield* agentCommit(3, 30);
        yield* ledger.hook(repo, "install", cli);

        const push = yield* gitRun(
          repo,
          ["push", "--atomic", "origin", "main", "agent-ledger"],
          env,
        );
        assert.strictEqual(push.code, 0, push.err);
        const remote = yield* git(repo, ["ls-remote", "origin"]);
        assert.include(remote, `${three}\trefs/heads/main`);
        assert.include(remote, `${l1}\trefs/heads/agent-ledger`);
        // The hook still recorded the new commit, locally, for the next push.
        assert.include(
          yield* git(repo, ["ls-tree", "-r", "--name-only", "agent-ledger"]),
          `commits/${three}.json`,
        );
        assert.isTrue(yield* fs.exists(path.join(repo, ".git", "hooks", "pre-push")));
      }).pipe(Effect.provide(ledgerLayer({ dbPath: "/nonexistent/state.sqlite", codexHome })));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("never overwrites or removes a hook the user changed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { repo } = yield* makeRepo;
      const hookFile = path.join(repo, ".git", "hooks", "pre-push");
      yield* Effect.gen(function* () {
        const ledger = yield* Ledger;
        yield* ledger.hook(repo, "install", "'/bin/toolreader'");
        const script = yield* fs.readFileString(hookFile);
        const edited = script.replace(/exit 0\n$/, "./check-before-push.sh || exit 1\nexit 0\n");
        assert.notStrictEqual(edited, script);
        yield* fs.writeFileString(hookFile, edited);

        const reinstall = yield* Effect.flip(ledger.hook(repo, "install", "'/bin/toolreader'"));
        assert.include(reinstall.message, "changed");
        const uninstall = yield* Effect.flip(ledger.hook(repo, "uninstall", "'/bin/toolreader'"));
        assert.include(uninstall.message, "changed");
        assert.strictEqual(yield* fs.readFileString(hookFile), edited);
      }).pipe(
        Effect.provide(
          ledgerLayer({ dbPath: "/nonexistent/state.sqlite", codexHome: "/nonexistent" }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("reads a Codex home that holds only archived sessions", () =>
    Effect.gen(function* () {
      const { repo, commitFile } = yield* makeRepo;
      const codexHome = yield* tempDir("toolreader-codex-home-");
      yield* git(repo, ["switch", "-q", "-c", "feat/x"]);
      const sha = yield* commitFile("a.ts", "a\n", "feat: a", "2026-01-01T10:02:30Z");
      yield* writeRollout(
        codexHome,
        "old",
        repo,
        [
          { at: "2026-01-01T10:01:00.000Z", item: userMessage("u1", "Add a") },
          {
            at: "2026-01-01T10:02:00.000Z",
            item: command("c1", "git commit -m 'feat: a'", `[feat/x ${sha.slice(0, 7)}] feat: a\n`),
          },
        ],
        "exec",
        "archived_sessions",
      );
      yield* Effect.gen(function* () {
        const ledger = yield* Ledger;
        const named = yield* ledger.sync(repo, null, { source: "codex-rollouts" });
        assert.deepStrictEqual(
          named.added.flatMap((a) => a.links.map((l) => [a.commit.sha, l.via])),
          [[sha, "sha"]],
        );
      }).pipe(Effect.provide(ledgerLayer({ dbPath: "/nonexistent/state.sqlite", codexHome })));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "links every thread of a commit: a trailer, a subagent's edits, a reviewer, notes; and unlinks",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { repo, commitFile } = yield* makeRepo;
        yield* git(repo, ["switch", "-q", "-c", "feat/x"]);
        yield* fs.writeFileString(path.join(repo, "b.ts"), "b\n");
        yield* git(repo, ["add", "b.ts"]);
        // A coder that never ran `git commit` itself; the commit names it by trailer.
        const sha = yield* commitFile(
          "a.ts",
          "a\n",
          "feat: a and b\n\nAgent-Session: codex:N1",
          "2026-01-01T10:10:00Z",
        );
        const thread = (id: string, title: string, entries: Entry[]): ThreadView => ({
          thread: {
            id,
            source: "t3",
            origin: null,
            title,
            projectId: "p",
            projectTitle: "repo",
            provider: "codex",
            status: "idle",
            archived: false,
            updatedAt: "2026-01-01T10:30:00Z",
            actionCount: 1,
            worktree: repo,
            head: "h",
          },
          entries,
          labels: {},
        });
        const t3 = [
          thread("t-coder", "Write a", [
            { type: "message", id: "u1", at: "2026-01-01T10:00:00Z", role: "user", text: "a" },
            action("w1", "2026-01-01T10:05:00Z", "printf 'a' > a.ts"),
          ]),
          thread("t-sub", "Write b", [action("w2", "2026-01-01T10:06:00Z", "printf 'b' > b.ts")]),
          thread("t-review", "Review a", [action("r1", "2026-01-01T10:20:00Z", "git show HEAD")]),
          thread("t-late", "Write c", [action("w3", "2026-01-01T10:30:00Z", "printf 'c' > c.ts")]),
        ];
        const dbPath = path.join(yield* tempDir("toolreader-t3-"), "state.sqlite");
        yield* fs.writeFileString(dbPath, "");
        const show = () =>
          git(repo, ["show", `agent-ledger:commits/${sha}.json`]).pipe(Effect.map(decodeEntry));

        yield* Effect.gen(function* () {
          const ledger = yield* Ledger;
          const synced = yield* ledger.sync(repo, null, { source: "t3" });
          assert.deepStrictEqual(
            synced.added.flatMap((a) => a.links.map((l) => [l.title, l.role, l.via])),
            [
              ["Write a", "coder", "trailer"],
              ["Write b", "coder", "evidence"],
            ],
          );
          let entry = yield* show();
          assert.deepStrictEqual(
            entry.links.map((l) => [l.thread.id, l.thread.parent, l.files]),
            [
              ["t-coder", null, ["a.ts"]],
              ["t-sub", "t-coder", ["b.ts"]],
            ],
          );
          assert.deepStrictEqual(entry.files, [
            { path: "a.ts", bucket: "attributed" },
            { path: "b.ts", bucket: "attributed" },
          ]);

          // The reviewer, as `ledger review` names it from CLAUDE_CODE_SESSION_ID.
          const before = yield* git(repo, ["rev-parse", "agent-ledger"]);
          const { linked } = yield* ledger.assert(repo, "HEAD", {
            link: { session: "claude-code:R1", role: "reviewer", reviewed: true },
          });
          assert.deepStrictEqual(
            [linked?.thread.id, linked?.via, linked?.reviewedSha, linked?.entries.map((e) => e.id)],
            ["t-review", "asserted", sha, ["r1"]],
          );
          assert.strictEqual(
            yield* git(repo, ["diff", "--name-only", before, "agent-ledger"]),
            `commits/${sha}.json`,
            "one entry changes, nothing else",
          );
          yield* ledger.assert(repo, sha, { note: { text: "b by hand", file: "b.ts" } });
          const notInCommit = yield* Effect.flip(
            ledger.assert(repo, sha, { note: { text: "x", file: "nope.ts" } }),
          );
          assert.include(notInCommit.message, "nope.ts");
          const unknown = yield* Effect.flip(
            ledger.assert(repo, sha, { link: { session: "codex:nobody", role: "coder" } }),
          );
          assert.include(unknown.message, "No session codex:nobody");

          // Sync again: the asserted link and the note stay, and nothing is written.
          const tip = yield* git(repo, ["rev-parse", "agent-ledger"]);
          yield* ledger.sync(repo, null, { source: "t3" });
          assert.strictEqual(yield* git(repo, ["rev-parse", "agent-ledger"]), tip);
          entry = yield* show();
          assert.deepStrictEqual(
            entry.links.map((l) => [l.thread.id, l.role]),
            [
              ["t-coder", "coder"],
              ["t-sub", "coder"],
              ["t-review", "reviewer"],
            ],
          );
          assert.deepStrictEqual(
            entry.notes.map((n) => [n.text, n.file]),
            [["b by hand", "b.ts"]],
          );

          yield* ledger.assert(repo, sha, { unlink: "t-sub" });
          entry = yield* show();
          assert.deepStrictEqual(
            entry.links.map((l) => l.thread.id),
            ["t-coder", "t-review"],
          );
          assert.deepStrictEqual(entry.files[1], { path: "b.ts", bucket: "untracked" });
          const missing = yield* Effect.flip(ledger.assert(repo, sha, { unlink: "t-sub" }));
          assert.include(missing.message, "no link");
          // Sync finds t-sub again by its edits, and leaves it out; linking by hand brings it back.
          yield* ledger.sync(repo, null, { source: "t3" });
          assert.notInclude(
            (yield* show()).links.map((l) => l.thread.id),
            "t-sub",
          );

          // Pushed; then a note on a local branch that began on its own: the push keeps both.
          yield* ledger.sync(repo, null, { source: "t3", push: true });
          yield* git(repo, ["update-ref", "-d", "refs/heads/agent-ledger"]);
          yield* ledger.assert(repo, sha, { note: { text: "after push", file: null } });
          yield* ledger.sync(repo, null, { source: "t3", push: true });
          const onOrigin = decodeEntry(
            yield* git(repo, ["show", `origin/agent-ledger:commits/${sha}.json`]),
          );
          assert.deepStrictEqual(
            [onOrigin.links.map((l) => l.thread.id), onOrigin.notes.map((n) => n.text)],
            [
              ["t-coder", "t-review"],
              ["b by hand", "after push"],
            ],
          );
          yield* ledger.assert(repo, sha, { link: { session: "t-sub", role: "coder" } });
          assert.include(
            (yield* show()).links.map((l) => l.thread.id),
            "t-sub",
          );

          // A merge brings its branch's files, not its own: no evidence, nothing recorded.
          yield* git(repo, ["switch", "-q", "-c", "side", "main"]);
          yield* commitFile("c.ts", "c\n", "feat: c", "2026-01-01T10:35:00Z");
          yield* git(repo, ["switch", "-q", "feat/x"]);
          yield* git(
            repo,
            ["merge", "-q", "--no-ff", "-m", "merge side", "side"],
            "2026-01-01T10:40:00Z",
          );
          const merge = yield* git(repo, ["rev-parse", "HEAD"]);
          yield* ledger.sync(repo, null, { source: "t3" });
          const merged = decodeEntry(
            yield* git(repo, ["show", `agent-ledger:commits/${merge}.json`]),
          );
          assert.deepStrictEqual([merged.links, merged.files], [[], []]);

          // Plumbing only: the code branch and working tree are untouched.
          assert.strictEqual(yield* git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "feat/x");
          assert.strictEqual(yield* git(repo, ["status", "--porcelain"]), "");
        }).pipe(
          Effect.provide(
            ledgerLayer({
              dbPath,
              codexHome: "/nonexistent",
              t3,
              nativeIds: [
                ["N1", "t-coder"],
                ["R1", "t-review"],
              ],
              parents: [["t-sub", "t-coder"]],
            }),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "installs a commit hook that names the agent session once, and never stops a commit",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { repo } = yield* makeRepo;
        const hookFile = path.join(repo, ".git", "hooks", "prepare-commit-msg");
        const trailers = () =>
          git(repo, ["log", "-1", "--format=%(trailers:key=Agent-Session,valueonly)"]);
        const plain = { CODEX_THREAD_ID: "", CLAUDE_CODE_SESSION_ID: "" };

        yield* Effect.gen(function* () {
          const ledger = yield* Ledger;
          yield* ledger.hook(repo, "install", "'/no/such/toolreader'");
          assert.isFalse(yield* fs.exists(hookFile), "only with --commit");
          assert.match(
            yield* ledger.hook(repo, "install", "'/no/such/toolreader'", { commit: true }),
            /Already installed: .*pre-push\.\nInstalled .*prepare-commit-msg\./,
          );

          const agent = { ...plain, CODEX_THREAD_ID: "01a0" };
          assert.strictEqual(
            (yield* gitRun(repo, ["commit", "-q", "--allow-empty", "-m", "by agent"], agent)).code,
            0,
          );
          yield* gitRun(repo, ["commit", "-q", "--allow-empty", "--amend", "--no-edit"], agent);
          assert.strictEqual(yield* trailers(), "codex:01a0", "once, even after an amend");

          yield* gitRun(repo, ["commit", "-q", "--allow-empty", "-m", "by hand"], plain);
          assert.strictEqual(yield* git(repo, ["log", "-1", "--format=%B"]), "by hand");

          assert.match(
            yield* ledger.hook(repo, "uninstall", "'/no/such/toolreader'"),
            /Removed .*pre-push\.\nRemoved .*prepare-commit-msg\./,
          );
          assert.isFalse(yield* fs.exists(hookFile));
        }).pipe(
          Effect.provide(
            ledgerLayer({ dbPath: "/nonexistent/state.sqlite", codexHome: "/nonexistent" }),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
