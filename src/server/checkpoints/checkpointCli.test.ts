import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toLedgerEntry } from "../../core/checkpoint.ts";
import { LedgerEntry, ledgerPath } from "../../core/ledger.ts";
import { collect } from "./checkpointCli.ts";
import { Checkpoints } from "./Checkpoints.ts";
import { DIRECT_WORKSPACE, DirectSink } from "../directSink.ts";
import { CheckpointStore } from "../backend/CheckpointStore.ts";
import { ClaudeTranscripts } from "../ClaudeTranscripts.ts";
import { CodexRollouts } from "../CodexRollouts.ts";
import { CodexSessions } from "../CodexSessions.ts";
import { Labeler } from "../Labeler.ts";
import { Ledger } from "../Ledger.ts";
import { PgMigrationsLive } from "../backend/PgMigrations.ts";
import { Sanitizer } from "../Sanitizer.ts";
import { ServerConfig } from "../ServerConfig.ts";
import { inWorkspace, PgTestLive } from "../backend/testPostgres.ts";
import { ThreadStore } from "../ThreadStore.ts";

const decodeEntry = Schema.decodeUnknownSync(Schema.fromJsonString(LedgerEntry));

/** git with fixed identity and dates, so commits line up with the sessions' actions. */
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

/** A `codex exec` rollout file in `codexHome`, one turn of `items`. */
const writeRollout = (
  codexHome: string,
  id: string,
  cwd: string,
  items: ReadonlyArray<{ at: string; item: object }>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(codexHome, "sessions", "2026", "01", "01");
    yield* fs.makeDirectory(dir, { recursive: true });
    const first = items[0]!.at;
    const line = (timestamp: string, type: string, payload: object) =>
      JSON.stringify({ timestamp, type, payload });
    yield* fs.writeFileString(
      path.join(dir, `rollout-2026-01-01T00-00-00-${id}.jsonl`),
      [
        line(first, "session_meta", { id, timestamp: first, cwd, originator: "codex_exec" }),
        line(first, "event_msg", { type: "task_started", turn_id: `${id}-t1` }),
        ...items.map(({ at, item }) =>
          line(at, "event_msg", { type: "item_completed", turn_id: `${id}-t1`, item }),
        ),
        line(items.at(-1)!.at, "event_msg", { type: "task_complete", turn_id: `${id}-t1` }),
      ].join("\n"),
    );
  });
const prompt = (id: string, text: string) => ({
  type: "UserMessage",
  id,
  content: [{ type: "text", text }],
});
const command = (id: string, script: string, output = "") => ({
  type: "CommandExecution",
  id,
  command: ["/bin/zsh", "-lc", script],
  cwd: "/repo",
  status: "completed",
  aggregated_output: output,
  exit_code: 0,
});
const fileChange = (id: string, file: string) => ({
  type: "FileChange",
  id,
  changes: { [file]: { type: "add", content: "x\n" } },
  status: "completed",
});

/**
 * A repo with one agent commit (a.ts, 10:05) and four sessions: the coder that committed it (its
 * SHA printed), one that only staged it through the shell, one in another worktree that edited
 * a.ts there, and one whose actions all came before the commit's parent.
 */
const scenario = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repo = yield* tempDir("toolreader-collect-");
  const elsewhere = path.join(yield* tempDir("toolreader-collect-wt-"), "wt");
  const codexHome = yield* tempDir("toolreader-collect-codex-");
  yield* git(repo, ["init", "-q", "-b", "main"]);
  yield* git(repo, ["config", "user.name", "Agent"]);
  yield* git(repo, ["config", "user.email", "agent@example.test"]);
  yield* fs.writeFileString(path.join(repo, "README.md"), "hi\n");
  yield* git(repo, ["add", "README.md"]);
  yield* git(repo, ["commit", "-q", "-m", "init"], "2026-01-01T09:00:00Z");
  yield* git(repo, ["worktree", "add", "-q", "-b", "other", elsewhere]);
  yield* git(repo, ["switch", "-q", "-c", "feat/x"]);
  yield* fs.writeFileString(path.join(repo, "a.ts"), "x\n");
  yield* git(repo, ["add", "a.ts"]);
  yield* git(repo, ["commit", "-q", "-m", "feat: a"], "2026-01-01T10:05:00Z");
  const sha = yield* git(repo, ["rev-parse", "HEAD"]);

  yield* writeRollout(codexHome, "coder", repo, [
    { at: "2026-01-01T10:00:00.000Z", item: prompt("u1", "Add a") },
    { at: "2026-01-01T10:01:00.000Z", item: fileChange("f1", path.join(repo, "a.ts")) },
    {
      at: "2026-01-01T10:04:50.000Z",
      item: command("c1", "git commit -m 'feat: a'", `[feat/x ${sha.slice(0, 7)}] feat: a`),
    },
  ]);
  yield* writeRollout(codexHome, "shell", repo, [
    { at: "2026-01-01T10:02:00.000Z", item: prompt("u2", "Stage a") },
    { at: "2026-01-01T10:03:00.000Z", item: command("s1", "git add a.ts") },
  ]);
  yield* writeRollout(codexHome, "other", elsewhere, [
    { at: "2026-01-01T10:02:00.000Z", item: prompt("u3", "Other") },
    { at: "2026-01-01T10:03:00.000Z", item: fileChange("f3", path.join(elsewhere, "a.ts")) },
  ]);
  yield* writeRollout(codexHome, "idle", repo, [
    { at: "2026-01-01T08:00:00.000Z", item: prompt("u4", "Earlier") },
    { at: "2026-01-01T08:01:00.000Z", item: command("i1", "cat a.ts") },
  ]);
  return { repo, codexHome, sha, name: path.basename(repo) };
});

/** Ledger and Checkpoints over the real rollout reader (no T3); the store comes from the suite. */
const services = (codexHome: string) => {
  const config = Layer.succeed(
    ServerConfig,
    ServerConfig.of({
      port: 0,
      home: "/home/me",
      dbPath: "/nonexistent/state.sqlite",
      codexBin: "codex",
      codexHome,
      claudeHome: "/nonexistent",
      labelsPath: "",
      userConfigPath: "",
      distDir: "",
    }),
  );
  return Layer.mergeAll(Ledger.layer, Checkpoints.layer).pipe(
    Layer.provide([CodexRollouts.layer, ClaudeTranscripts.layer, DirectSink]),
    Layer.provide([
      config,
      ThreadStore.empty,
      CodexSessions.disabled,
      Sanitizer.off,
      Layer.succeed(
        Labeler,
        Labeler.of({ forThread: () => Effect.succeed({}), label: () => Effect.die("unused") }),
      ),
    ]),
  );
};

const options = {
  source: "codex-rollouts" as const,
  sessions: [],
  matchSessions: false,
  replace: false,
  outputs: true,
  maxOutput: 8192,
};
const stored = (name: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ id: string }>`SELECT id FROM checkpoints WHERE repo = ${name} ORDER BY id`.pipe(
      Effect.map((rows) => rows.map((r) => r.id)),
    ),
  );

const TestLive = CheckpointStore.layer.pipe(
  Layer.provideMerge(PgMigrationsLive),
  Layer.provideMerge(PgTestLive),
  Layer.provideMerge(NodeServices.layer),
);

describe("checkpoint collect", () => {
  it.layer(TestLive, { timeout: 120_000 })((it) => {
    it.effect("stores exactly the range's links, once, as ledger sync would write them", () =>
      Effect.gen(function* () {
        const { repo, codexHome, sha, name } = yield* scenario;
        const coder = `commit:${name}:${sha}:codex:coder:coder`;
        yield* Effect.gen(function* () {
          const first = yield* collect({ ...options, repo, scope: { range: "main..HEAD" } });
          const [report] = first.commits;
          assert.deepStrictEqual(
            report?.taken.map((t) => [t.id, t.result, t.via]),
            [[coder, "inserted", "sha"]],
          );
          // Only staged through the shell: listed for a decision, not stored.
          assert.deepStrictEqual(report?.candidates, [
            { title: "Stage a", signals: ["staged", "active"] },
          ]);
          assert.deepStrictEqual(yield* stored(name), [coder]);

          const again = yield* collect({ ...options, repo, scope: { sha } });
          assert.deepStrictEqual(
            again.commits[0]?.taken.map((t) => [t.id, t.result]),
            [[coder, "exists"]],
          );
          assert.deepStrictEqual(yield* stored(name), [coder]);

          // The checkpoint reads back as the entry ledger sync writes for the same commit.
          yield* Effect.flatMap(Ledger, (l) =>
            l.sync(repo, "main..HEAD", { source: "codex-rollouts" }),
          );
          const entry = decodeEntry(yield* git(repo, ["show", `agent-ledger:${ledgerPath(sha)}`]));
          const cp = Option.getOrThrow(
            yield* Effect.flatMap(inWorkspace(DIRECT_WORKSPACE), (s) => s.get(coder)),
          );
          assert.deepStrictEqual(
            toLedgerEntry({ commit: entry.commit, paths: cp.commit!.paths }, [cp]),
            entry,
          );

          // A candidate a person links (`ledger link`) is taken by the next collection.
          yield* Effect.flatMap(Ledger, (l) =>
            l.assert(repo, sha, {
              link: { session: "codex:shell", role: "coder", reviewed: false },
            }),
          );
          const linked = yield* collect({ ...options, repo, scope: { sha } });
          assert.deepStrictEqual(
            linked.commits[0]?.taken.map((t) => [t.via, t.result]),
            [
              ["sha", "exists"],
              ["asserted", "inserted"],
            ],
          );
          assert.deepStrictEqual(linked.commits[0]?.candidates, []);
        }).pipe(Effect.provide(services(codexHome)));
      }).pipe(Effect.scoped),
    );
  });
});
