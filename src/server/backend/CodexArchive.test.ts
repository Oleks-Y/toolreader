// Real HTTP, Postgres, and artifact files. Run in .docker/compose.codex-pilot-test.yml.
import * as NodeCrypto from "node:crypto";
// The byte comparison checks the original file, separately from its JSONB events.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as Config from "effect/Config";
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
const artifact = (sessionId: string, output: string, cwd?: string) =>
  Buffer.from(
    [
      { type: "session_meta", payload: { id: sessionId, source: "cli", future: true, cwd } },
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
      .map((row) => encodeJson({ timestamp: "2026-10-28T00:00:00.000Z", ...row }))
      .join("\n") + "\n",
  );

describe("Codex private pilot", () => {
  it.layer(TestLive, { timeout: 120_000 })((it) => {
    it.effect("exposes complete events from multiple sources with workspace isolation", () =>
      Effect.gen(function* () {
        const store = yield* HistoryStore;
        const token = yield* store.createToken("complete-events", "machine");
        const api = yield* client(token);
        const params = { ws: "complete-events" };
        const sessionId = NodeCrypto.randomUUID();
        const mediaData = Buffer.from("synthetic image bytes");
        const mediaSha256 = NodeCrypto.createHash("sha256").update(mediaData).digest("hex");
        for (const source of ["rollout", "hook"] as const) {
          const data = Buffer.from(
            [
              { type: "session_meta", payload: { id: sessionId } },
              {
                type: source === "hook" ? "hook.PermissionRequest" : "future_event",
                payload: {
                  complete: "x".repeat(12000),
                  commandId: "command-a",
                  source,
                  media: [`toolreader-media:${mediaSha256}`],
                },
              },
            ]
              .map((r) => encodeJson(r))
              .join("\n") + "\n",
          );
          const sha256 = NodeCrypto.createHash("sha256").update(data).digest("hex");
          const { uploadId } = yield* api.history.codexStart({
            params,
            payload: {
              source,
              sessionId,
              rootId: sessionId,
              sha256,
              sourceSha256: sha256,
              copyKind: "filtered",
              includedDirectories: [],
              bytes: data.length,
              parts: 1,
            },
          });
          yield* api.history.codexPart({
            params,
            payload: { uploadId, part: 0, data: data.toString("base64") },
          });
          assert.strictEqual(
            (yield* api.history.codexFinish({ params, payload: { uploadId } })).events,
            2,
          );
        }
        const rows = yield* api.history.sql({
          params,
          payload: {
            query:
              "SELECT source,length(data->'payload'->>'complete') AS chars FROM agent_history_events WHERE event_type <> 'session_meta' ORDER BY source",
          },
        });
        assert.deepStrictEqual(rows.rows, [
          { source: "hook", chars: 12000 },
          { source: "rollout", chars: 12000 },
        ]);
        yield* store.setMedia("complete-events", true);
        yield* api.history.putMedia({
          params,
          payload: { sha256: mediaSha256, mime: "image/png", data: mediaData.toString("base64") },
        });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE media SET uploaded_at=now()-interval '2 hours' WHERE sha256=${mediaSha256}`;
        const orphans = yield* store.orphanMedia;
        assert.isFalse(orphans.some((item) => item.sha256 === mediaSha256));
        const rawFiles = yield* api.history.sql({
          params,
          payload: { query: "SELECT source,file_path FROM agent_codex_artifacts ORDER BY source" },
        });
        assert.strictEqual(rawFiles.rows.length, 2);
        const outsider = yield* store.workspace("complete-outsider");
        const hidden = yield* Effect.flatMap(AgentSql, (s) =>
          s.query(outsider, "SELECT * FROM agent_history_events"),
        );
        assert.deepStrictEqual(hidden.rows, []);
        const forbidden = yield* Effect.flip(
          api.history.sql({ params, payload: { query: "SELECT * FROM codex_events" } }),
        );
        assert.strictEqual(forbidden._tag, "QueryRefused");
      }),
    );
    it.effect(
      "hides legacy exact events and replaces their file after a matching filtered backfill",
      () =>
        Effect.gen(function* () {
          const store = yield* HistoryStore;
          const token = yield* store.createToken("codex-backfill", "machine");
          const api = yield* client(token);
          const params = { ws: "codex-backfill" };
          const workspace = yield* store.workspace("codex-backfill");
          const sessionId = NodeCrypto.randomUUID();
          const original = artifact(sessionId, "old unfiltered secret");
          const sourceSha256 = NodeCrypto.createHash("sha256").update(original).digest("hex");
          const dir = yield* Config.string("TOOLREADER_CODEX_ARCHIVE_DIR");
          const folder = NodePath.join(dir, workspace, sessionId);
          const oldFile = NodePath.join(folder, `${sourceSha256}.jsonl`);
          yield* Effect.promise(async () => {
            await NodeFSP.mkdir(folder, { recursive: true });
            await NodeFSP.writeFile(oldFile, original);
          });
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO codex_artifacts ${sql.insert({ workspace_id: workspace, session_id: sessionId, sha256: sourceSha256, bytes: original.length, event_count: 1, file_path: oldFile, source: "rollout", copy_kind: "exact" })}`;
          yield* sql`INSERT INTO codex_events ${sql.insert({ workspace_id: workspace, session_id: sessionId, sha256: sourceSha256, seq: 1, type: "session_meta", at: null, raw: encodeJson({ type: "session_meta", payload: { id: sessionId, secret: "old unfiltered secret" } }) })}`;
          yield* sql`INSERT INTO codex_selections ${sql.insert({ workspace_id: workspace, root_id: sessionId, session_id: sessionId, sha256: sourceSha256 })}`;
          const before = yield* api.history.codexInventory({ params, payload: {} });
          assert.strictEqual(
            before.artifacts.find((item) => item.version === sourceSha256)?.copyKind,
            "exact",
          );
          const hidden = yield* api.history.sql({
            params,
            payload: { query: "SELECT * FROM agent_history_events" },
          });
          assert.deepStrictEqual(hidden.rows, []);
          for (const view of ["agent_codex_events", "agent_codex_artifacts"] as const) {
            const legacy = yield* api.history.sql({
              params,
              payload: { query: `SELECT * FROM ${view}` },
            });
            assert.deepStrictEqual(legacy.rows, []);
          }
          const filtered = artifact(sessionId, "[redacted]");
          const sha256 = NodeCrypto.createHash("sha256").update(filtered).digest("hex");
          const { uploadId } = yield* api.history.codexStart({
            params,
            payload: {
              sessionId,
              rootId: sessionId,
              source: "rollout",
              copyKind: "filtered",
              sourceSha256,
              includedDirectories: [],
              sha256,
              bytes: filtered.length,
              parts: 1,
            },
          });
          yield* api.history.codexPart({
            params,
            payload: { uploadId, part: 0, data: filtered.toString("base64") },
          });
          yield* api.history.codexFinish({ params, payload: { uploadId } });
          const after = yield* api.history.codexInventory({ params, payload: {} });
          assert.isFalse(after.artifacts.some((item) => item.version === sourceSha256));
          assert.strictEqual(
            after.artifacts.find((item) => item.version === sha256)?.sourceSha256,
            sourceSha256,
          );
          const visible = yield* api.history.sql({
            params,
            payload: {
              query: "SELECT version FROM agent_history_events WHERE event_type='session_meta'",
            },
          });
          assert.deepStrictEqual(visible.rows, [{ version: sha256 }]);
          assert.isFalse(
            yield* Effect.promise(() =>
              NodeFSP.stat(oldFile).then(
                () => true,
                () => false,
              ),
            ),
          );
        }),
    );
    it.effect("refuses new exact uploads under the default retention setting", () =>
      Effect.gen(function* () {
        const token = yield* Effect.flatMap(HistoryStore, (store) =>
          store.createToken("codex-no-exact", "machine"),
        );
        const api = yield* client(token);
        const sessionId = NodeCrypto.randomUUID();
        const data = artifact(sessionId, "private exact source");
        const sha256 = NodeCrypto.createHash("sha256").update(data).digest("hex");
        const refused = yield* Effect.flip(
          api.history.codexStart({
            params: { ws: "codex-no-exact" },
            payload: { sessionId, rootId: sessionId, sha256, bytes: data.length, parts: 1 },
          }),
        );
        assert.strictEqual(refused._tag, "Rejected");
      }),
    );
    it.effect("refuses one filtered digest being assigned to two source versions", () =>
      Effect.gen(function* () {
        const token = yield* Effect.flatMap(HistoryStore, (store) =>
          store.createToken("codex-version", "machine"),
        );
        const api = yield* client(token);
        const params = { ws: "codex-version" };
        const sessionId = NodeCrypto.randomUUID();
        const data = artifact(sessionId, "filtered text");
        const sha256 = NodeCrypto.createHash("sha256").update(data).digest("hex");
        for (const sourceSha256 of ["a".repeat(64), "b".repeat(64)]) {
          const { uploadId } = yield* api.history.codexStart({
            params,
            payload: {
              sessionId,
              rootId: sessionId,
              copyKind: "filtered",
              sourceSha256,
              includedDirectories: [],
              sha256,
              bytes: data.length,
              parts: 1,
            },
          });
          yield* api.history.codexPart({
            params,
            payload: { uploadId, part: 0, data: data.toString("base64") },
          });
          const completed = api.history.codexFinish({ params, payload: { uploadId } });
          if (sourceSha256.startsWith("a")) yield* completed;
          else assert.strictEqual((yield* Effect.flip(completed))._tag, "Rejected");
        }
      }),
    );
    it.effect("accepts a changed directory list for the same filtered bytes and source", () =>
      Effect.gen(function* () {
        const token = yield* Effect.flatMap(HistoryStore, (store) =>
          store.createToken("codex-directory-resync", "machine"),
        );
        const api = yield* client(token);
        const params = { ws: "codex-directory-resync" };
        const sessionId = NodeCrypto.randomUUID();
        const data = artifact(sessionId, "same filtered text");
        const sha256 = NodeCrypto.createHash("sha256").update(data).digest("hex");
        for (const includedDirectories of [["/repo"], ["/repo", "/shared"]]) {
          const { uploadId } = yield* api.history.codexStart({
            params,
            payload: {
              sessionId,
              rootId: sessionId,
              copyKind: "filtered",
              sourceSha256: "a".repeat(64),
              includedDirectories,
              sha256,
              bytes: data.length,
              parts: 1,
            },
          });
          yield* api.history.codexPart({
            params,
            payload: { uploadId, part: 0, data: data.toString("base64") },
          });
          yield* api.history.codexFinish({ params, payload: { uploadId } });
        }
        const result = yield* api.history.sql({
          params,
          payload: { query: "SELECT included_directories FROM agent_codex_artifacts" },
        });
        assert.deepStrictEqual(result.rows, [{ included_directories: ["/repo", "/shared"] }]);
      }),
    );
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
                timestamp: "2026-10-28T00:00:01.000Z",
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
                timestamp: "2026-10-28T00:00:01.000Z",
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
                    "history",
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
            assert.strictEqual(Number(success.exit), 0, `${success.stdout}\n${success.stderr}`);
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
            const legacyId = NodeCrypto.randomUUID();
            const legacySource = artifact(legacyId, "API_KEY=synthetic-legacy-secret", dir);
            const legacyHash = NodeCrypto.createHash("sha256").update(legacySource).digest("hex");
            yield* fs.writeFileString(
              path.join(sessions, `rollout-test-${legacyId}.jsonl`),
              legacySource.toString(),
            );
            const archiveDir = yield* Config.string("TOOLREADER_CODEX_ARCHIVE_DIR");
            const legacyDir = path.join(archiveDir, workspace, legacyId);
            const legacyFile = path.join(legacyDir, `${legacyHash}.jsonl`);
            yield* fs.makeDirectory(legacyDir, { recursive: true });
            yield* fs.writeFileString(legacyFile, legacySource.toString());
            yield* sql`INSERT INTO codex_artifacts ${sql.insert({ workspace_id: workspace, session_id: legacyId, sha256: legacyHash, bytes: legacySource.length, event_count: 1, file_path: legacyFile, source: "rollout", copy_kind: "exact" })}`;
            yield* sql`INSERT INTO codex_events ${sql.insert({ workspace_id: workspace, session_id: legacyId, sha256: legacyHash, seq: 1, type: "session_meta", at: null, raw: encodeJson({ type: "session_meta", payload: { id: legacyId } }) })}`;
            const backfill = yield* spawner.spawn(
              ChildProcess.make("node", [path.resolve("dist/bin.mjs"), "history", "backfill"], {
                env: {
                  HOME: dir,
                  CODEX_HOME: path.join(dir, "codex"),
                  TOOLREADER_CONFIG: configFile,
                  PATH: process.env.PATH,
                },
                extendEnv: false,
              }),
            );
            const [backfillExit, backfillOut, backfillErr] = yield* Effect.all(
              [
                backfill.exitCode,
                backfill.stdout.pipe(Stream.decodeText(), Stream.mkString),
                backfill.stderr.pipe(Stream.decodeText(), Stream.mkString),
              ],
              { concurrency: 3 },
            );
            assert.strictEqual(Number(backfillExit), 0, `${backfillOut}\n${backfillErr}`);
            assert.include(backfillOut, "Backfill: 1/1 legacy artifacts");
            const afterBackfill = yield* sql<{
              copy_kind: string;
            }>`SELECT copy_kind FROM codex_artifacts WHERE workspace_id=${workspace} AND session_id=${legacyId}`;
            assert.deepStrictEqual(
              afterBackfill.map((row) => row.copy_kind),
              ["filtered"],
            );
            assert.isFalse(yield* fs.exists(legacyFile));
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
                sourceSha256: sha256,
                copyKind: "filtered",
                includedDirectories: [],
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
              payload: {
                sessionId,
                rootId: sessionId,
                sha256,
                sourceSha256: sha256,
                copyKind: "filtered",
                includedDirectories: [],
                bytes: data.length,
                parts: 1,
              },
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
