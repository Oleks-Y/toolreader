// The history hooks as git runs them (sh, with a fake toolreader that records its call), and the
// installer that writes them.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { stopTarget } from "./historyCli.ts";
import { commitMsgHook, hookFile, prePushHook, sealHook } from "./historyHooks.ts";
import {
  commitSkill,
  dirtyPaths,
  INSTALLED_PATHS,
  installSkill,
  CAPTURE_COMMAND,
  REMIND_COMMAND,
  SKILL,
  sealSkill,
  skillFiles,
} from "./historySkill.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const HookEntries = Schema.Array(
  Schema.Struct({
    matcher: Schema.optional(Schema.String),
    hooks: Schema.Array(Schema.Struct({ type: Schema.String, command: Schema.String })),
  }),
);
const decodeHooks = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      hooks: Schema.Struct({
        PostToolUse: Schema.optional(HookEntries),
        Stop: Schema.optional(HookEntries),
        SubagentStop: Schema.optional(HookEntries),
      }),
    }),
  ),
);

const sh = (cwd: string, args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make("sh", args, { cwd, env, extendEnv: true }),
    );
    const [out, code] = yield* Effect.all([
      handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      handle.exitCode,
    ]);
    return { out: out.trim(), code: Number(code) };
  }).pipe(Effect.scoped);

/** A repo with one pushed commit and one more, and a fake toolreader that writes its arguments. */
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
    `#!/bin/sh\necho "$@" > "${calls}.tmp"\nmv "${calls}.tmp" "${calls}"\n`,
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
      "git push -q origin main",
      "git -c user.name=a -c user.email=a@b commit -q --allow-empty -m two",
    ].join(" && "),
  ]);
  const head = (yield* sh(repo, ["-c", "git rev-parse HEAD"])).out;
  const base = (yield* sh(repo, ["-c", "git rev-parse origin/main"])).out;
  yield* fs.writeFileString(`${repo}/.git/hooks/pre-push`, prePushHook(`'${fake}'`));
  yield* fs.chmod(`${repo}/.git/hooks/pre-push`, 0o755);
  return { dir, repo, origin, calls, fake, head, base };
});

/** The fake's call, once the hook's background job has made it (or null after `ms`). */
const called = (calls: string, ms = 8000) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    for (let waited = 0; waited < ms; waited += 50) {
      if (yield* fs.exists(calls)) return (yield* fs.readFileString(calls)).trim();
      yield* Effect.sleep("50 millis");
    }
    return null;
  });

describe("history hooks", () => {
  it.live("pre-push syncs what origin took, in the background, only once opted in", () =>
    Effect.gen(function* () {
      const { repo, calls, fake, head, base } = yield* setup;
      const fs = yield* FileSystem.FileSystem;
      // Not opted in: nothing.
      yield* sh(repo, ["-c", "git push -q origin main"]);
      assert.isNull(yield* called(calls, 500));
      yield* sh(repo, [
        "-c",
        "git -c user.name=a -c user.email=a@b commit -q --allow-empty -m three && git config toolreader.history true",
      ]);
      const three = (yield* sh(repo, ["-c", "git rev-parse HEAD"])).out;
      // The fake answers late: the push must not wait for it.
      yield* fs.writeFileString(
        fake,
        `#!/bin/sh\nsleep 2\n${(yield* fs.readFileString(fake)).slice(10)}`,
      );
      const started = yield* Clock.currentTimeMillis;
      assert.strictEqual((yield* sh(repo, ["-c", "git push -q origin main"])).code, 0);
      assert.isBelow((yield* Clock.currentTimeMillis) - started, 1500);
      assert.strictEqual(
        yield* called(calls),
        `history sync --repo ${repo} --range ${three} --not ${head} --hook`,
      );
      assert.notStrictEqual(head, base);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("pre-push sends nothing for a push origin refused, and logs it", () =>
    Effect.gen(function* () {
      const { dir, repo, origin, calls } = yield* setup;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${origin}/hooks/pre-receive`, "#!/bin/sh\nexit 1\n");
      yield* fs.chmod(`${origin}/hooks/pre-receive`, 0o755);
      yield* sh(repo, ["-c", "git config toolreader.history true"]);
      const refused = yield* sh(repo, [
        "-c",
        `HOME="${dir}" TOOLREADER_PUSH_CONFIRM_TRIES=1 git push -q origin main 2>/dev/null; echo $?`,
      ]);
      assert.notStrictEqual(refused.out, "0");
      // The log, once the background job has asked origin: what it says, the fake never called.
      assert.include(yield* called(`${dir}/.toolreader/history.log`), "skipped main");
      // Private from the start, though the shell wrote it.
      assert.strictEqual((yield* fs.stat(`${dir}/.toolreader/history.log`)).mode & 0o777, 0o600);
      assert.isFalse(yield* fs.exists(calls));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("remind, after a commit, warns when this repo's delivery is failing", () =>
    Effect.gen(function* () {
      const { dir, repo } = yield* setup;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const bin = path.resolve(import.meta.dirname, "..", "bin.ts");
      const remind = (cwd: string) =>
        sh(dir, ["-c", 'printf "%s" "$INPUT" | node "$BIN" history remind'], {
          HOME: dir,
          BIN: bin,
          INPUT: encodeJson({
            tool_name: "Bash",
            cwd,
            tool_input: { command: "git commit -m x" },
          }),
        });
      assert.notInclude((yield* remind(repo)).out, "delivery is failing");
      const common = (yield* sh(repo, [
        "-c",
        "git rev-parse --path-format=absolute --git-common-dir",
      ])).out;
      yield* fs.makeDirectory(`${dir}/.toolreader/pending`, { recursive: true });
      yield* fs.writeFileString(
        `${dir}/.toolreader/pending/a.json`,
        encodeJson({
          repo: common,
          range: "a..b",
          firstFailureAt: "2026-10-25T23:23:10.000Z",
          lastAttemptAt: "2026-10-26T08:00:00.000Z",
          lastErrorCode: "CONNECTION_REFUSED",
        }),
      );
      const warned = yield* remind(repo);
      assert.strictEqual(warned.code, 0);
      assert.include(
        warned.out,
        "history delivery is failing: 1 range pending since 2026-10-25T23:23Z; run `toolreader history status`",
      );
      // Another repo's pending ranges are its own.
      assert.notInclude((yield* remind(dir)).out, "delivery is failing");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("commit-msg names the agent session a commit is made in", () =>
    Effect.gen(function* () {
      const { repo } = yield* setup;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${repo}/.git/hooks/commit-msg`, commitMsgHook());
      yield* fs.chmod(`${repo}/.git/hooks/commit-msg`, 0o755);
      const commit = (env: Record<string, string>) =>
        sh(
          repo,
          [
            "-c",
            "git -c user.name=a -c user.email=a@b commit -q --allow-empty -m change && git log -1 --format=%B",
          ],
          env,
        );
      assert.include((yield* commit({ CODEX_THREAD_ID: "abc" })).out, "Agent-Session: codex:abc");
      assert.notInclude(
        (yield* commit({ CODEX_THREAD_ID: "", CLAUDE_CODE_SESSION_ID: "" })).out,
        "Agent-Session",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("replaces its own hook after an upgrade, and never touches one someone edited", () =>
    Effect.gen(function* () {
      const { repo } = yield* setup;
      const fs = yield* FileSystem.FileSystem;
      const file = `${repo}/.git/hooks/pre-push`;
      // setup wrote an unsealed script: not ours to replace.
      assert.include(
        (yield* Effect.flip(hookFile(repo, "pre-push", prePushHook("'/new'"), "install"))).message,
        "not toolreader's",
      );
      yield* fs.writeFileString(file, sealHook(prePushHook("'/old'")));
      assert.match(
        yield* hookFile(repo, "pre-push", prePushHook("'/new'"), "install"),
        /^Updated /,
      );
      assert.include(yield* fs.readFileString(file), "'/new'");
      yield* fs.writeFileString(file, `${yield* fs.readFileString(file)}echo mine\n`);
      assert.include(
        (yield* Effect.flip(hookFile(repo, "pre-push", prePushHook("'/new'"), "uninstall")))
          .message,
        "leaving it alone",
      );
      assert.isTrue(yield* fs.exists(file));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live(
    "installs the agent skill for Claude Code and Codex, and leaves an edited one alone",
    () =>
      Effect.gen(function* () {
        const { repo } = yield* setup;
        const fs = yield* FileSystem.FileSystem;
        const file = `${repo}/.claude/skills/toolreader-history/SKILL.md`;
        assert.match(yield* skillFiles(repo, "install"), /^Installed /);
        assert.include(yield* fs.readFileString(file), "toolreader history link --sha HEAD");
        // Codex reads the same file through the link.
        assert.strictEqual(
          yield* fs.readFileString(`${repo}/.agents/skills/toolreader-history/SKILL.md`),
          yield* fs.readFileString(file),
        );
        assert.match(yield* skillFiles(repo, "install"), /^Already installed/);
        // Written by an older toolreader: replaced.
        yield* fs.writeFileString(file, sealSkill(`${SKILL}An older rule.\n`));
        assert.match(yield* skillFiles(repo, "install"), /^Updated /);
        yield* fs.writeFileString(file, `${yield* fs.readFileString(file)}\nMy own rule.\n`);
        assert.include(
          (yield* Effect.flip(skillFiles(repo, "uninstall"))).message,
          "leaving it alone",
        );
        assert.isTrue(yield* fs.exists(file));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("installs the skill, rule and reminder around what's there, and commits only those", () =>
    Effect.gen(function* () {
      const { repo } = yield* setup;
      const fs = yield* FileSystem.FileSystem;
      const git = (args: string) =>
        sh(repo, ["-c", `git -c user.name=a -c user.email=a@b ${args}`]).pipe(
          Effect.map((r) => r.out),
        );
      const read = (p: string) => fs.readFileString(`${repo}/${p}`);
      yield* fs.makeDirectory(`${repo}/.claude`, { recursive: true });
      yield* fs.writeFileString(`${repo}/AGENTS.md`, "# Team rules\n\nBe kind.\n");
      yield* fs.writeFileString(
        `${repo}/.claude/settings.json`,
        '{"permissions":{"allow":["Bash(ls)"]}}\n',
      );
      yield* git("add -A && git -c user.name=a -c user.email=a@b commit -qm rules");
      yield* fs.writeFileString(`${repo}/mine.txt`, "staged by me\n");
      yield* git("add mine.txt");

      const installed = yield* installSkill(repo, "install");
      assert.deepStrictEqual(installed.failed, []);
      assert.include(
        yield* read("AGENTS.md"),
        "# Team rules\n\nBe kind.\n\n<!-- toolreader-history",
      );
      assert.include(yield* read("AGENTS.md"), "toolreader history link --sha HEAD");
      assert.include(yield* read("CLAUDE.md"), "toolreader history link --sha HEAD");
      const settings = (yield* read(".claude/settings.json")) as string;
      assert.include(settings, '"Bash(ls)"');
      assert.include(settings, REMIND_COMMAND);
      // Codex: the same hooks, in its own file.
      for (const file of [".claude/settings.json", ".codex/hooks.json"]) {
        const hooks = decodeHooks(yield* read(file)).hooks;
        assert.deepStrictEqual(
          [hooks.PostToolUse, hooks.Stop, hooks.SubagentStop],
          [
            [{ matcher: "Bash", hooks: [{ type: "command", command: REMIND_COMMAND }] }],
            [{ hooks: [{ type: "command", command: CAPTURE_COMMAND }] }],
            [{ hooks: [{ type: "command", command: CAPTURE_COMMAND }] }],
          ],
          file,
        );
      }
      assert.deepStrictEqual(yield* dirtyPaths(repo, INSTALLED_PATHS), [
        ".claude/skills/toolreader-history",
        ".agents/skills/toolreader-history",
        "AGENTS.md",
        "CLAUDE.md",
        ".claude/settings.json",
        ".codex/hooks.json",
      ]);
      assert.strictEqual(
        yield* commitSkill(repo, "install", INSTALLED_PATHS),
        "Committed the skill.",
      );
      assert.strictEqual(yield* git("diff --cached --name-only"), "mine.txt");
      // Again: nothing changes.
      assert.isTrue(
        (yield* installSkill(repo, "install")).lines.every((l) => l.startsWith("Already")),
      );
      assert.strictEqual(
        yield* commitSkill(repo, "install", INSTALLED_PATHS),
        "The skill is committed as it is.",
      );

      yield* installSkill(repo, "uninstall");
      assert.strictEqual(yield* read("AGENTS.md"), "# Team rules\n\nBe kind.\n");
      assert.isFalse(yield* fs.exists(`${repo}/CLAUDE.md`));
      assert.isFalse(yield* fs.exists(`${repo}/.codex/hooks.json`));
      assert.notInclude((yield* read(".claude/settings.json")) as string, "toolreader");
      assert.strictEqual(
        yield* commitSkill(repo, "uninstall", INSTALLED_PATHS),
        "Committed its removal.",
      );
      assert.strictEqual(yield* git("ls-files .agents .claude/skills CLAUDE.md"), "");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("upgrades its agent hooks to add the stop capture, and keeps others' stop hooks", () =>
    Effect.gen(function* () {
      const { repo } = yield* setup;
      const fs = yield* FileSystem.FileSystem;
      const file = `${repo}/.claude/settings.json`;
      yield* fs.makeDirectory(`${repo}/.claude`, { recursive: true });
      // An older toolreader's reminder, and someone's own Stop hook.
      const mine = { hooks: [{ type: "command", command: "say done" }] };
      yield* fs.writeFileString(
        file,
        encodeJson({
          hooks: {
            PostToolUse: [
              { matcher: "Bash", hooks: [{ type: "command", command: REMIND_COMMAND }] },
            ],
            Stop: [mine],
          },
        }),
      );
      const installed = yield* installSkill(repo, "install");
      assert.isTrue(
        installed.lines.some((l) =>
          l.startsWith(`Updated the commit reminder and session capture hooks in ${file}`),
        ),
      );
      assert.deepStrictEqual(decodeHooks(yield* fs.readFileString(file)).hooks.Stop, [
        mine,
        { hooks: [{ type: "command", command: CAPTURE_COMMAND }] },
      ]);
      // Gone again with ours; theirs stays.
      yield* installSkill(repo, "uninstall");
      assert.deepStrictEqual(decodeHooks(yield* fs.readFileString(file)).hooks, { Stop: [mine] });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("reads which session stopped, from Claude Code's and Codex's hook input", () => {
    // Claude Code's Stop (SubagentStop adds agent_id and agent_transcript_path).
    assert.deepStrictEqual(
      stopTarget(
        encodeJson({
          session_id: "0c6e1b3a-7d61-4c3e-9a40-1f2b3c4d5e6f",
          transcript_path: "/home/u/.claude/projects/-repo/0c6e1b3a.jsonl",
          cwd: "/repo",
          hook_event_name: "SubagentStop",
          stop_hook_active: false,
          agent_id: "a1",
        }),
        "/elsewhere",
      ),
      { session: "0c6e1b3a-7d61-4c3e-9a40-1f2b3c4d5e6f", repo: "/repo" },
    );
    // Codex's Stop: a turn id and the last message too.
    assert.deepStrictEqual(
      stopTarget(
        encodeJson({
          session_id: "019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b",
          turn_id: "t3",
          hook_event_name: "Stop",
          last_assistant_message: "done",
        }),
        "/cwd",
      ),
      { session: "019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b", repo: "/cwd" },
    );
    // Nothing to name, or a name no session has (it would reach git as an argument).
    assert.isNull(stopTarget("", "/cwd"));
    assert.isNull(stopTarget(encodeJson({ session_id: "--upload-pack=x y" }), "/cwd"));
    assert.isNull(stopTarget(encodeJson({ session_id: "--repo" }), "/cwd"));
  });
});
