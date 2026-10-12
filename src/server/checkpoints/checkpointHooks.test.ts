// The checkpoint hooks as git runs them (sh, with a fake toolreader that records its call), and
// the commands behind them, run through the CLI with a temp HOME.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { Command } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { prePushHook } from "../../core/ledger.ts";
import { checkpointCommand } from "./checkpointCli.ts";
import {
  CHECKPOINT_HOOK_MARKER,
  checkpointPostRewriteHook,
  checkpointPrePushHook,
} from "./checkpointHooks.ts";
import { sealHook } from "../Ledger.ts";

const sh = (cwd: string, args: ReadonlyArray<string>, stdin = "") =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make("sh", args, { cwd, stdin: Stream.make(new TextEncoder().encode(stdin)) }),
    );
    const [out, code] = yield* Effect.all([
      handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      handle.exitCode,
    ]);
    return { out: out.trim(), code: Number(code) };
  }).pipe(Effect.scoped);

/** A repo with one commit, and a fake toolreader that writes its arguments and stdin to `calls`. */
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "toolreader-hooks-" }),
  );
  const repo = path.join(dir, "repo");
  const calls = path.join(dir, "calls");
  const fake = path.join(dir, "fake-toolreader");
  yield* fs.makeDirectory(repo);
  yield* fs.writeFileString(
    fake,
    `#!/bin/sh\n{ echo "$@"; cat; } > "${calls}.tmp"\nmv "${calls}.tmp" "${calls}"\n`,
  );
  yield* fs.chmod(fake, 0o755);
  const origin = path.join(dir, "origin.git");
  yield* sh(dir, ["-c", `git init -q --bare -b main "${origin}"`]);
  yield* sh(repo, [
    "-c",
    [
      "git init -q -b main",
      `git remote add origin "${origin}"`,
      "git -c user.name=a -c user.email=a@b commit -q --allow-empty -m one",
      // What origin has: the first commit.
      "git push -q origin main",
      "git -c user.name=a -c user.email=a@b commit -q --allow-empty -m two",
    ].join(" && "),
  ]);
  const head = (yield* sh(repo, ["-c", "git rev-parse HEAD"])).out;
  const base = (yield* sh(repo, ["-c", "git rev-parse origin/main"])).out;
  return { dir, repo, origin, calls, fake, head, base };
});

/** The fake's call, once the hook's background job has made it (or null after `ms`). */
const called = (calls: string, ms = 5000) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    for (let waited = 0; waited < ms; waited += 50) {
      if (yield* fs.exists(calls)) return yield* fs.readFileString(calls);
      yield* Effect.sleep("50 millis");
    }
    return null;
  });

/** `toolreader checkpoint <args>` with HOME (and nothing else) in its environment. */
const cli = (home: string, args: ReadonlyArray<string>) =>
  Command.runWith(checkpointCommand, { version: "0.0.0-test" })(args).pipe(
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({ env: { HOME: home, T3_DB: `${home}/none.sqlite` } }),
      ),
    ),
  );

describe("checkpoint hooks", () => {
  it.live("pre-push collects each pushed branch in the background, only once opted in", () =>
    Effect.gen(function* () {
      const { dir, repo, calls, fake, head, base } = yield* setup;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${repo}/.git/hooks/pre-push`, checkpointPrePushHook(`'${fake}'`));
      yield* fs.chmod(`${repo}/.git/hooks/pre-push`, 0o755);
      yield* sh(repo, [
        "-c",
        `git init -q --bare "${dir}/upstream.git" && git remote add upstream "${dir}/upstream.git"`,
      ]);
      yield* sh(repo, ["-c", `git tag v1 ${base}`]);

      // Not opted in: nothing.
      yield* sh(repo, ["-c", "git push -q upstream main"]);
      assert.isNull(yield* called(calls, 300));
      yield* sh(repo, ["-c", "git config toolreader.checkpoints true"]);
      // Another remote: nothing.
      yield* sh(repo, ["-c", "git push -q upstream main v1"]);
      assert.isNull(yield* called(calls, 300));

      // The fake answers late: the push must not wait for it.
      yield* fs.writeFileString(
        fake,
        `#!/bin/sh\nsleep 2\n${(yield* fs.readFileString(fake)).slice(10)}`,
      );
      const started = yield* Clock.currentTimeMillis;
      assert.strictEqual((yield* sh(repo, ["-c", "git push -q origin main v1"])).code, 0);
      assert.isBelow((yield* Clock.currentTimeMillis) - started, 1500);
      assert.strictEqual(
        (yield* called(calls))?.trim(),
        `checkpoint collect --repo ${repo} --range ${head} --not ${base} --hook`,
      );
      // One job, branch after branch: a tag's call would come 2 s after this one. None does.
      const first = yield* fs.readFileString(calls);
      yield* Effect.sleep("3 seconds");
      assert.strictEqual(yield* fs.readFileString(calls), first);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("pre-push collects only what origin took, from what the push adds", () =>
    Effect.gen(function* () {
      const { dir, repo, origin, calls, fake, head, base } = yield* setup;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${repo}/.git/hooks/pre-push`, checkpointPrePushHook(`'${fake}'`));
      yield* fs.chmod(`${repo}/.git/hooks/pre-push`, 0o755);
      yield* sh(repo, ["-c", "git config toolreader.checkpoints true"]);
      const range = () =>
        called(calls).pipe(Effect.map((c) => c?.split("\n")[0]?.match(/--range (.*) --hook/)?.[1]));

      // A force push over a commit someone else pushed, which this clone never fetched.
      yield* sh(dir, [
        "-c",
        [
          `git clone -q "${origin}" other`,
          "cd other",
          "git -c user.name=b -c user.email=b@c commit -q --allow-empty -m theirs",
          "git push -q origin main",
        ].join(" && "),
      ]);
      yield* sh(repo, ["-c", "git push -q -f origin main"]);
      assert.strictEqual(yield* range(), `${head} --not ${base}`);

      // Refused by origin (branch protection, secret scanning): nothing is collected or sent,
      // and the log says why.
      yield* fs.remove(calls).pipe(Effect.ignore);
      yield* fs.writeFileString(`${origin}/hooks/pre-receive`, "#!/bin/sh\nexit 1\n");
      yield* fs.chmod(`${origin}/hooks/pre-receive`, 0o755);
      yield* sh(repo, [
        "-c",
        "git -c user.name=a -c user.email=a@b commit -q --allow-empty -m three",
      ]);
      const refused = yield* sh(repo, [
        "-c",
        `HOME="${dir}" TOOLREADER_PUSH_CONFIRM_TRIES=2 git push -q origin main 2>/dev/null; echo $?`,
      ]);
      assert.notStrictEqual(refused.out, "0");
      assert.isNull(yield* called(calls, 5000));
      assert.include(yield* fs.readFileString(`${dir}/.toolreader/checkpoint.log`), "skipped main");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("post-rewrite hands git's old → new pairs to `checkpoint rewrite`", () =>
    Effect.gen(function* () {
      const { dir, repo, calls, fake } = yield* setup;
      const fs = yield* FileSystem.FileSystem;
      const hook = `${dir}/post-rewrite`;
      yield* fs.writeFileString(hook, checkpointPostRewriteHook(`'${fake}'`));
      yield* sh(repo, ["-c", "git config toolreader.checkpoints true"]);
      const pairs = `${"a".repeat(40)} ${"b".repeat(40)}\n${"c".repeat(40)} ${"d".repeat(40)} extra\n`;
      assert.strictEqual((yield* sh(repo, [hook, "rebase"], pairs)).code, 0);
      assert.strictEqual(
        (yield* called(calls))?.trim(),
        `checkpoint rewrite --repo ${repo} --hook\n${"a".repeat(40)} ${"b".repeat(40)}\n${"c".repeat(40)} ${"d".repeat(40)}`,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("install opts the repo in and writes the hooks; uninstall undoes it", () =>
    Effect.gen(function* () {
      const { dir, repo } = yield* setup;
      const fs = yield* FileSystem.FileSystem;
      const optIn = sh(repo, ["-c", "git config --bool toolreader.checkpoints || true"]);
      // The ledger's own pre-push, as it writes it: not ours to replace.
      const ledgerHook = sealHook(prePushHook("'/bin/toolreader' ledger"));
      yield* fs.makeDirectory(`${repo}/.git/hooks`, { recursive: true });
      yield* fs.writeFileString(`${repo}/.git/hooks/pre-push`, ledgerHook);
      const refused = yield* Effect.flip(cli(dir, ["hook", "install", "--repo", repo]));
      assert.include(String((refused as { message?: string }).message), "other pre-push hook");
      assert.strictEqual(yield* fs.readFileString(`${repo}/.git/hooks/pre-push`), ledgerHook);
      yield* fs.remove(`${repo}/.git/hooks/pre-push`);
      yield* cli(dir, ["hook", "install", "--repo", repo]);
      assert.strictEqual((yield* optIn).out, "true");
      for (const name of ["pre-push", "post-rewrite"])
        assert.include(
          yield* fs.readFileString(`${repo}/.git/hooks/${name}`),
          CHECKPOINT_HOOK_MARKER,
        );
      assert.include(yield* fs.readFileString(`${repo}/.git/hooks/commit-msg`), "Agent-Session");
      // Again: nothing changes.
      yield* cli(dir, ["hook", "install", "--repo", repo]);

      yield* cli(dir, ["hook", "uninstall", "--repo", repo]);
      assert.strictEqual((yield* optIn).out, "");
      assert.isFalse(yield* fs.exists(`${repo}/.git/hooks/pre-push`));
      assert.isFalse(yield* fs.exists(`${repo}/.git/hooks/post-rewrite`));
      // Opted out, a commit gets no trailer either.
      assert.isFalse(yield* fs.exists(`${repo}/.git/hooks/commit-msg`));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("the Stop hook notes a session only in an opted-in repo, and never fails", () =>
    Effect.gen(function* () {
      const { dir, repo } = yield* setup;
      const fs = yield* FileSystem.FileSystem;
      const pending = `${dir}/.toolreader/pending.jsonl`;
      const codex = `{"type":"agent-turn-complete","thread-id":"t1","turn-id":"u1","cwd":"${repo}"}`;
      yield* cli(dir, ["hook", "stop", codex]);
      assert.isFalse(yield* fs.exists(pending));

      yield* sh(repo, ["-c", "git config toolreader.checkpoints true"]);
      yield* cli(dir, ["hook", "stop", codex]);
      yield* cli(dir, [
        "hook",
        "stop",
        `{"session_id":"s1","transcript_path":"/t.jsonl","cwd":"${repo}"}`,
      ]);
      const lines = (yield* fs.readFileString(pending)).trim().split("\n");
      assert.deepStrictEqual(
        lines.map((l) => {
          const { session, turn, transcript } = JSON.parse(l);
          return [session, turn, transcript];
        }),
        [
          ["codex:t1", "u1", null],
          ["claude-code:s1", null, "/t.jsonl"],
        ],
      );

      yield* cli(dir, ["hook", "stop", "not json"]);
      assert.include(yield* fs.readFileString(`${dir}/.toolreader/checkpoint.log`), "stop hook");

      // Past 1 MB the log moves to checkpoint.log.1 and starts again.
      const log = `${dir}/.toolreader/checkpoint.log`;
      yield* fs.writeFileString(log, "x".repeat(1024 * 1024 + 1));
      yield* cli(dir, ["hook", "stop", "not json"]);
      assert.strictEqual((yield* fs.stat(`${log}.1`)).size, BigInt(1024 * 1024 + 1));
      assert.match(yield* fs.readFileString(log), /^\S+ stop hook\n/);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("collect --hook logs a failure to checkpoint.log and succeeds; without it, fails", () =>
    Effect.gen(function* () {
      const { dir, repo } = yield* setup;
      const fs = yield* FileSystem.FileSystem;
      yield* cli(dir, ["collect", "--repo", repo, "--sha", "HEAD", "--hook"]);
      const log = yield* fs.readFileString(`${dir}/.toolreader/checkpoint.log`);
      assert.include(log, `collect HEAD in ${repo}`);
      assert.include(log, "✗ No checkpoint backend");
      const error = yield* Effect.flip(cli(dir, ["collect", "--repo", repo, "--sha", "HEAD"]));
      assert.include(String((error as { message?: string }).message), "No checkpoint backend");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
