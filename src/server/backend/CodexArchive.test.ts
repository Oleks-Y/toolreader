// Real HTTP, Postgres, and artifact files. Run in .docker/compose.codex-pilot-test.yml.
import * as NodeCrypto from "node:crypto";
// The byte comparison checks the original file, separately from its JSONB events.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as HttpServer from "effect/unstable/http/HttpServer";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ARCHIVE } from "../../core/codexArchive.ts";
import { BackendApi, CLIENT_HEADER } from "../../core/historyApi.ts";
import { AgentSql } from "./AgentSql.ts";
import { BackendRoutes } from "./Backend.ts";
import { GitHub } from "./GitHub.ts";
import { HistoryStore } from "./HistoryStore.ts";
import { MediaBucket } from "./MediaBucket.ts";
import { PgMigrationsLive } from "./PgMigrations.ts";
import { PgTestLive } from "./testPostgres.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const TestLive = HttpRouter.serve(BackendRoutes, {
  disableListenLog: true,
  disableLogger: true,
}).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(GitHub.disabled),
  Layer.provideMerge(MediaBucket.memory(new Map())),
  Layer.provideMerge(AgentSql.layer()),
  Layer.provideMerge(HistoryStore.layer),
  Layer.provideMerge(PgMigrationsLive),
  Layer.provideMerge(PgTestLive),
  Layer.provideMerge(NodeServices.layer),
);
const client = (token: string) =>
  HttpApiClient.make(BackendApi, {
    transformClient: HttpClient.mapRequest(
      HttpClientRequest.setHeaders({ authorization: `Bearer ${token}`, [CLIENT_HEADER]: "0.1.0" }),
    ),
  });
const artifact = (sessionId: string, output: string) =>
  Buffer.from(
    [
      { type: "session_meta", payload: { id: sessionId, source: "cli", future: true } },
      {
        type: "turn_context",
        payload: {
          developer_instructions: "Keep all available context",
          sandbox: { mode: "workspace-write" },
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-1",
          arguments: encodeJson({ cmd: "test command", max_output_tokens: 100000 }),
        },
      },
      {
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call-1", output },
      },
      { type: "future_record", payload: { unknown: [1, 2, { value: "retained" }] } },
    ]
      .map((row) => encodeJson(row))
      .join("\n") + "\n",
  );

describe("Codex private pilot", () => {
  it.layer(TestLive, { timeout: 120_000 })((it) => {
    it.effect(
      "runs the packaged CLI over HTTP, selects direct peers only, and returns failure on upload errors",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pilot-e2e-" });
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            const git = (args: string[]) =>
              spawner.string(ChildProcess.make("git", args, { cwd: dir }));
            yield* git(["init", "-q"]);
            yield* git(["config", "user.name", "Pilot test"]);
            yield* git(["config", "user.email", "pilot@example.invalid"]);
            yield* git(["remote", "add", "origin", "https://github.com/acme/pilot.git"]);
            yield* fs.writeFileString(path.join(dir, "file"), "test");
            yield* git(["add", "file"]);
            yield* git(["-c", "core.hooksPath=/dev/null", "commit", "-qm", "test commit"]);
            const root = NodeCrypto.randomUUID();
            const peer = NodeCrypto.randomUUID();
            const unrelated = NodeCrypto.randomUUID();
            const sessions = path.join(dir, "codex", "sessions");
            yield* fs.makeDirectory(sessions, { recursive: true });
            const own =
              artifact(root, "root output").toString() +
              encodeJson({
                type: "response_item",
                payload: {
                  type: "function_call",
                  name: "send_input",
                  arguments: encodeJson({ id: peer, message: "please check" }),
                },
              }) +
              "\n";
            const related =
              artifact(peer, "peer context").toString() +
              encodeJson({
                type: "response_item",
                payload: {
                  type: "function_call",
                  name: "send_input",
                  arguments: encodeJson({ id: unrelated, message: "unrelated" }),
                },
              }) +
              "\n";
            yield* fs.writeFileString(path.join(sessions, `rollout-test-${root}.jsonl`), own);
            yield* fs.writeFileString(path.join(sessions, `rollout-test-${peer}.jsonl`), related);
            yield* fs.writeFileString(
              path.join(sessions, `rollout-test-${unrelated}.jsonl`),
              "must never parse this",
            );
            const store = yield* HistoryStore;
            const token = yield* store.createToken("pilot-cli-e2e", "machine");
            const address = (yield* HttpServer.HttpServer).address;
            assert.strictEqual(address._tag, "TcpAddress");
            if (address._tag !== "TcpAddress") return;
            const configFile = path.join(dir, "config.json");
            yield* fs.writeFileString(
              configFile,
              encodeJson({
                backend: {
                  url: `http://127.0.0.1:${address.port}`,
                  workspace: "pilot-cli-e2e",
                  token,
                },
              }),
            );
            const run = Effect.fn("test.pilotCli")(function* (config: string) {
              const handle = yield* spawner.spawn(
                ChildProcess.make(
                  "node",
                  [
                    path.resolve("dist/bin.mjs"),
                    "pilot",
                    "sync",
                    "--session",
                    root,
                    "--repo",
                    dir,
                    "--sha",
                    "HEAD",
                  ],
                  {
                    env: {
                      HOME: dir,
                      CODEX_HOME: path.join(dir, "codex"),
                      TOOLREADER_CONFIG: config,
                      PATH: process.env.PATH,
                    },
                    extendEnv: false,
                  },
                ),
              );
              const [exit, stdout, stderr] = yield* Effect.all(
                [
                  handle.exitCode,
                  handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
                  handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
                ],
                { concurrency: 3 },
              );
              return { exit, stdout, stderr };
            });
            const success = yield* run(configFile);
            assert.strictEqual(Number(success.exit), 0, success.stderr);
            assert.include(success.stdout, "Synced 2 selected Codex sessions");
            const workspace = yield* store.workspace("pilot-cli-e2e");
            const sql = yield* SqlClient.SqlClient;
            const held = yield* sql<{
              session_id: string;
            }>`SELECT session_id FROM codex_artifacts WHERE workspace_id=${workspace}`;
            assert.deepStrictEqual(held.map((r) => r.session_id).sort(), [root, peer].sort());
            const links = yield* sql<{
              session_id: string;
            }>`SELECT session_id FROM codex_commit_links WHERE workspace_id=${workspace}`;
            assert.deepStrictEqual(
              links.map((r) => r.session_id),
              [root],
            );
            yield* fs.writeFileString(
              configFile,
              encodeJson({
                backend: {
                  url: `http://127.0.0.1:${address.port}`,
                  workspace: "pilot-cli-e2e",
                  token: "trk_invalid",
                },
              }),
            );
            const failure = yield* run(configFile);
            assert.notStrictEqual(Number(failure.exit), 0);
            assert.notInclude(failure.stdout, "Synced 2 selected");
          }),
        ),
    );
    it.effect(
      "round trips full multi-chunk artifacts, SQL context, and retained commit links across versions",
      () =>
        Effect.gen(function* () {
          const store = yield* HistoryStore;
          const token = yield* store.createToken("codex-roundtrip", "machine");
          const api = yield* client(token);
          const workspace = yield* store.workspace("codex-roundtrip");
          const params = { ws: "codex-roundtrip" };
          const sessionId = NodeCrypto.randomUUID();
          const output =
            "secret-context-kept-in-private-archive\n" + "x".repeat(ARCHIVE.chunkBytes + 234);
          const original = artifact(sessionId, output);
          const upload = Effect.fn("test.upload")(function* (data: Buffer) {
            const sha256 = NodeCrypto.createHash("sha256").update(data).digest("hex");
            const { uploadId } = yield* api.history.codexStart({
              params,
              payload: {
                sessionId,
                rootId: sessionId,
                sha256,
                bytes: data.length,
                parts: Math.ceil(data.length / ARCHIVE.chunkBytes),
              },
            });
            for (let part = 0; part < Math.ceil(data.length / ARCHIVE.chunkBytes); part++)
              yield* api.history.codexPart({
                params,
                payload: {
                  uploadId,
                  part,
                  data: data
                    .subarray(part * ARCHIVE.chunkBytes, (part + 1) * ARCHIVE.chunkBytes)
                    .toString("base64"),
                },
              });
            const receipt = yield* api.history.codexFinish({ params, payload: { uploadId } });
            assert.strictEqual(receipt.events, 5);
            assert.strictEqual(receipt.sha256, sha256);
            return sha256;
          });
          const version = yield* upload(original);
          const link = {
            repo: "acme/app",
            sha: "a".repeat(40),
            sessionId,
            role: "implemented" as const,
          };
          yield* api.history.codexLink({ params, payload: link });
          yield* upload(artifact(sessionId, "newer output"));
          const sql = yield* SqlClient.SqlClient;
          const held = yield* sql<{
            file_path: string;
          }>`SELECT file_path FROM codex_artifacts WHERE workspace_id=${workspace} AND sha256=${version}`;
          const file = yield* Effect.promise(() => NodeFSP.readFile(held[0]!.file_path));
          assert.deepStrictEqual(file, original);
          const query = yield* Effect.flatMap(AgentSql, (s) =>
            s.query(
              workspace,
              `SELECT length(tool_output #>> '{}') AS bytes FROM agent_codex_events WHERE version='${version}' AND call_id='call-1' AND tool_output IS NOT NULL`,
            ),
          );
          assert.strictEqual(query.rows[0]?.bytes, output.length);
          const context = yield* api.history.sql({
            params,
            payload: {
              query:
                "SELECT payload->>'developer_instructions' AS instructions FROM agent_codex_events WHERE type='turn_context'",
            },
          });
          assert.strictEqual(context.rows[0]?.instructions, "Keep all available context");
          const links = yield* api.history.sql({
            params,
            payload: { query: "SELECT repo,sha FROM agent_codex_commit_links" },
          });
          assert.strictEqual(links.rows.length, 1);
          const outsider = yield* store.workspace("codex-outsider");
          const isolated = yield* Effect.flatMap(AgentSql, (s) =>
            s.query(outsider, "SELECT * FROM agent_codex_events"),
          );
          assert.strictEqual(isolated.rows.length, 0);
        }),
    );
    it.effect(
      "fails missing parts, wrong hashes and malformed records without publishing incomplete rows",
      () =>
        Effect.gen(function* () {
          const token = yield* Effect.flatMap(HistoryStore, (s) =>
            s.createToken("codex-invalid", "machine"),
          );
          const api = yield* client(token);
          const other = yield* client(
            yield* Effect.flatMap(HistoryStore, (s) => s.createToken("codex-other", "machine")),
          );
          const params = { ws: "codex-invalid" };
          const sessionId = NodeCrypto.randomUUID();
          for (const kind of ["missing", "hash", "json", "session"] as const) {
            const data =
              kind === "json"
                ? Buffer.from('{"type":')
                : artifact(kind === "session" ? NodeCrypto.randomUUID() : sessionId, "out");
            const sha256 =
              kind === "hash"
                ? "0".repeat(64)
                : NodeCrypto.createHash("sha256").update(data).digest("hex");
            const { uploadId } = yield* api.history.codexStart({
              params,
              payload: { sessionId, rootId: sessionId, sha256, bytes: data.length, parts: 1 },
            });
            if (kind !== "missing")
              yield* api.history.codexPart({
                params,
                payload: { uploadId, part: 0, data: data.toString("base64") },
              });
            const refused = yield* Effect.flip(
              api.history.codexFinish({ params, payload: { uploadId } }),
            );
            assert.strictEqual(refused._tag, "Rejected");
            const crossWorkspace = yield* Effect.flip(
              other.history.codexFinish({ params, payload: { uploadId } }),
            );
            assert.strictEqual(crossWorkspace._tag, "Forbidden");
          }
          const sql = yield* SqlClient.SqlClient;
          const visible = yield* sql`SELECT * FROM codex_artifacts WHERE session_id=${sessionId}`;
          assert.strictEqual(visible.length, 0);
        }),
    );
  });
});
