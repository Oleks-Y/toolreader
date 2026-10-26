// A regression eval for answers about agent history (core/coverageEval.ts): seeds a throwaway
// backend from a fixture directory, asks an agent the fixture's question through `toolreader mcp`,
// and scores the answer. Against a stale fixture (copies imported while their sessions kept
// running) it fails an unqualified "never happened"; against a refreshed one it fails an answer
// missing the fixture's required terms.
//   node scripts/coverageEval.ts --fixture DIR --mode stale|fresh --out DIR
//     [--agent claude|codex] [--port 4799] [--dry-run]
// DIR holds `expect.json` ({question, required}), `threads/*.json` (thread records, as the backend
// stores them) and optionally `commits/*.json`. Fixtures are real sessions: keep them out of this
// repo (it is public). Each run writes to --out: the prompt, the tool descriptions, the MCP config,
// the agent's event stream (every tool request and response), its answer and the score. The agent
// runs with a home of its own under --out (only its login file copied in: Claude Code's
// .credentials.json, Codex's auth.json; on macOS, where Claude Code keeps its login in the
// keychain, set ANTHROPIC_API_KEY) and no built-in tools, so it reads nothing but the eval's backend.
// --dry-run seeds and writes everything but runs no model. Model runs are manual, never in tests:
// they cost money and read the fixture's sessions. Needs Docker (or TOOLREADER_TEST_PG_URL).
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { PgClient } from "@effect/sql-pg/PgClient";

import { EVAL_MODES, Expectation, scoreAnswer, type EvalMode } from "../src/core/coverageEval.ts";
import { AGENT_SCHEMA } from "../src/core/historyApi.ts";
import { readCommit, readThread } from "../src/core/historyRecord.ts";
import { BackendServerLive } from "../src/server/backend/Backend.ts";
import { GitHub } from "../src/server/backend/GitHub.ts";
import { HistoryStore } from "../src/server/backend/HistoryStore.ts";
import { MediaBucket } from "../src/server/backend/MediaBucket.ts";
import { PgMigrationsLive } from "../src/server/backend/PgMigrations.ts";
import { PgTestLive } from "../src/server/backend/testPostgres.ts";

class EvalFailed extends Schema.TaggedErrorClass<EvalFailed>()("EvalFailed", {
  message: Schema.String,
}) {}

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeExpect = Schema.decodeUnknownEffect(Schema.fromJsonString(Expectation));
/** One line of the agent's event stream: Claude Code's final result, or a Codex message. */
const Event = Schema.Struct({
  type: Schema.optional(Schema.String),
  result: Schema.optional(Schema.String),
  item: Schema.optional(
    Schema.Struct({ type: Schema.optional(Schema.String), text: Schema.optional(Schema.String) }),
  ),
});
const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(Event));

/** The agent's final answer, from its event stream. */
const answerOf = (stream: string) =>
  stream
    .split("\n")
    .flatMap((line) => Option.toArray(decodeEvent(line)))
    .flatMap((e) =>
      e.type === "result" && e.result !== undefined
        ? [e.result]
        : e.item?.type === "agent_message" && e.item.text !== undefined
          ? [e.item.text]
          : [],
    )
    .at(-1) ?? "";

/** TOML's basic string, for Codex's `-c` overrides: JSON's escapes are TOML's. */
const toml = Schema.encodeSync(Schema.fromJsonString(Schema.String));

const run = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fixture = option("--fixture");
  const mode = option("--mode") as EvalMode | undefined;
  const outArg = option("--out");
  const agent = option("--agent") ?? "claude";
  const port = Number(option("--port") ?? 4799);
  if (
    !fixture ||
    !outArg ||
    !mode ||
    !EVAL_MODES.includes(mode) ||
    !["claude", "codex"].includes(agent)
  )
    return yield* new EvalFailed({
      message:
        "usage: node scripts/coverageEval.ts --fixture DIR --mode stale|fresh --out DIR [--agent claude|codex] [--port N] [--dry-run]",
    });
  const out = path.resolve(outArg);
  const home = path.join(out, "home");
  yield* fs.makeDirectory(path.join(home, ".toolreader"), { recursive: true });
  const read = (file: string) =>
    fs
      .readFileString(path.join(fixture, file))
      .pipe(Effect.mapError(() => new EvalFailed({ message: `can't read ${file} in ${fixture}` })));
  const expect = yield* Effect.flatMap(read("expect.json"), decodeExpect).pipe(
    Effect.mapError(
      () => new EvalFailed({ message: `${fixture}/expect.json isn't {question, required}` }),
    ),
  );
  const records = <A>(dir: string, decode: (u: unknown) => Result.Result<A, string>) =>
    Effect.gen(function* () {
      const names = yield* fs
        .readDirectory(path.join(fixture, dir))
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      return yield* Effect.forEach(names.filter((n) => n.endsWith(".json")).sort(), (name) =>
        Effect.flatMap(read(`${dir}/${name}`), (text) =>
          Effect.flatMap(decodeJson(text), (json) =>
            Result.match(decode(json), {
              onSuccess: Effect.succeed,
              onFailure: (why) =>
                Effect.fail(new EvalFailed({ message: `${dir}/${name}: ${why}` })),
            }),
          ),
        ).pipe(Effect.mapError((e) => new EvalFailed({ message: e.message }))),
      );
    });
  const threads = yield* records("threads", readThread);
  const commits = yield* records("commits", readCommit);
  if (threads.length === 0)
    return yield* new EvalFailed({ message: `no threads/*.json in ${fixture}` });

  // Seeded as clients sent it, each copy checked when it was read: what coverage then reports.
  const store = yield* HistoryStore;
  const workspaceId = yield* store.workspace("eval");
  const token = yield* store.createToken("eval", "coverage-eval");
  const ws = store.at({ workspaceId, tokenId: null, client: "coverage-eval" });
  const sql = yield* PgClient;
  for (const t of threads) {
    yield* ws.putThread(t);
    yield* sql`UPDATE threads SET checked_at = ${t.takenAt}::timestamptz
               WHERE workspace_id = ${workspaceId} AND id = ${t.thread.id}`;
  }
  for (const c of commits) yield* ws.putCommit(c);

  const url = `http://127.0.0.1:${port}`;
  yield* fs.writeFileString(
    path.join(home, ".toolreader", "config.json"),
    encodeJson({ backend: { url, token, workspace: "eval" } }),
  );
  const bin = path.resolve(import.meta.dirname, "..", "src", "server", "bin.ts");
  // The MCP server reads the eval's backend, and no session store of this machine.
  const env = { HOME: home, T3_DB: path.join(home, "none.sqlite") };
  const prompt = `${expect.question}\n\nAnswer from the agent history the toolreader MCP server holds (its sql tool), citing conversation ids.`;
  yield* fs.writeFileString(path.join(out, "prompt.txt"), `${prompt}\n`);
  yield* fs.writeFileString(
    path.join(out, "tools.json"),
    encodeJson({ sql: AGENT_SCHEMA, media: "An image an agent's tool returned, by sha256." }),
  );
  const mcpConfig = path.join(out, "mcp.json");
  yield* fs.writeFileString(
    mcpConfig,
    encodeJson({
      mcpServers: { toolreader: { command: process.execPath, args: [bin, "mcp"], env } },
    }),
  );
  // The agent runs in a home of its own, holding only its login: no user config, MCP servers,
  // memories or session stores of this machine reach it, and its built-in tools are off, so the
  // MCP server's sql over the eval's backend is all it can read. Its stdin is closed: `codex exec`
  // reads a piped stdin to its end before starting.
  const realHome = yield* Config.string("HOME").pipe(
    Effect.mapError(() => new EvalFailed({ message: "HOME isn't set" })),
  );
  const agentHome = path.join(out, "agent-home");
  const agentEnv = {
    HOME: agentHome,
    CLAUDE_CONFIG_DIR: path.join(agentHome, ".claude"),
    CODEX_HOME: path.join(agentHome, ".codex"),
    T3_DB: env.T3_DB,
  };
  for (const [from, to] of [
    [path.join(realHome, ".claude", ".credentials.json"), agentEnv.CLAUDE_CONFIG_DIR],
    [path.join(realHome, ".codex", "auth.json"), agentEnv.CODEX_HOME],
  ] as const) {
    yield* fs.makeDirectory(to, { recursive: true, mode: 0o700 });
    if (yield* fs.exists(from).pipe(Effect.orElseSucceed(() => false)))
      yield* fs
        .copyFile(from, path.join(to, path.basename(from)))
        .pipe(Effect.mapError((e) => new EvalFailed({ message: e.message })));
  }
  const command =
    agent === "claude"
      ? ChildProcess.make(
          "claude",
          [
            "-p",
            prompt,
            "--mcp-config",
            mcpConfig,
            "--strict-mcp-config",
            // No built-in tool: no shell, no file reads, no web.
            "--tools",
            "",
            "--allowedTools",
            "mcp__toolreader__sql,mcp__toolreader__media",
            "--output-format",
            "stream-json",
            "--verbose",
          ],
          { cwd: out, env: agentEnv, extendEnv: true, stdin: "ignore" },
        )
      : ChildProcess.make(
          "codex",
          [
            "exec",
            "--json",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            // No shell, patches, web or images: only the MCP server's tools.
            ...[
              "features.shell_tool=false",
              "features.unified_exec=false",
              "features.view_image=false",
              "include_apply_patch_tool=false",
              'web_search="disabled"',
            ].flatMap((c) => ["-c", c]),
            "-c",
            `mcp_servers.toolreader.command=${toml(process.execPath)}`,
            "-c",
            `mcp_servers.toolreader.args=[${toml(bin)}, "mcp"]`,
            "-c",
            `mcp_servers.toolreader.env={ HOME = ${toml(env.HOME)}, T3_DB = ${toml(env.T3_DB)} }`,
            prompt,
          ],
          { cwd: out, env: agentEnv, extendEnv: true, stdin: "ignore" },
        );
  if (flag("--dry-run")) {
    yield* Console.log(
      `seeded ${threads.length} threads, ${commits.length} commits; wrote ${out}/{prompt.txt,tools.json,mcp.json}; no model run (--dry-run)`,
    );
    return;
  }

  // The backend on 127.0.0.1 for as long as the agent runs.
  yield* Effect.forkScoped(Layer.launch(BackendServerLive(port)));
  const client = yield* HttpClient.HttpClient;
  yield* client.get(`${url}/v1/health`).pipe(
    Effect.flatMap((r) => (r.status === 200 ? Effect.void : Effect.fail(r))),
    Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 50 }),
    Effect.mapError(() => new EvalFailed({ message: `the backend didn't start on ${url}` })),
  );
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const stream = yield* spawner
    .string(command)
    .pipe(Effect.mapError((e) => new EvalFailed({ message: `${agent}: ${e.message}` })));
  yield* fs.writeFileString(path.join(out, "transcript.jsonl"), stream);
  const answer = answerOf(stream);
  yield* fs.writeFileString(path.join(out, "answer.md"), `${answer}\n`);
  const score = scoreAnswer(mode, answer, expect);
  const coverage = yield* ws.coverage;
  yield* fs.writeFileString(
    path.join(out, "result.json"),
    encodeJson({ mode, agent, ...score, coverage }),
  );
  yield* Console.log(`${mode}: ${score.pass ? "pass" : "FAIL"}`);
  for (const why of score.reasons) yield* Console.log(`  ${why}`);
  if (!score.pass) process.exitCode = 1;
});

run.pipe(
  Effect.scoped,
  Effect.catchTag("EvalFailed", (e) =>
    Console.error(`coverageEval: ${e.message}`).pipe(
      Effect.andThen(Effect.sync(() => (process.exitCode = 1))),
    ),
  ),
  Effect.provide(
    Layer.mergeAll(HistoryStore.layer, GitHub.disabled, MediaBucket.memory()).pipe(
      Layer.provideMerge(PgMigrationsLive),
      Layer.provideMerge(PgTestLive),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    ),
  ),
  NodeRuntime.runMain,
);
