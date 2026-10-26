// `history sync` end to end: a real git repo, a Codex session's rollout file, and the real backend
// (a test server on 127.0.0.1 over Docker Postgres).
import * as NodeCrypto from "node:crypto";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ThreadNotFound } from "../../core/api.ts";
import { snapshotValues } from "../../core/domain.ts";
import { SITE_DATA_MARKER } from "../../core/ledgerSite.ts";
import { BackendRoutes } from "../backend/Backend.ts";
import { GitHub } from "../backend/GitHub.ts";
import { HistoryStore } from "../backend/HistoryStore.ts";
import { MediaBucket } from "../backend/MediaBucket.ts";
import { PgMigrationsLive } from "../backend/PgMigrations.ts";
import { inWorkspace, PgTestLive } from "../backend/testPostgres.ts";
import { ClaudeTranscripts } from "../ClaudeTranscripts.ts";
import { CodexRollouts } from "../CodexRollouts.ts";
import { CodexSessions } from "../CodexSessions.ts";
import { Labeler } from "../Labeler.ts";
import { RepoSessions } from "../RepoSessions.ts";
import { ServerConfig } from "../ServerConfig.ts";
import { ThreadStore } from "../ThreadStore.ts";
import { HistorySync } from "./HistorySync.ts";
import { connect } from "./HistoryClient.ts";
import { pending } from "./historyHooks.ts";
import { capture, evidenceLines, hitLines, reportLines, saveMedia } from "./historyCli.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** The media bucket's objects, by key. */
const objects = new Map<string, Uint8Array>();

const ServerLive = HttpRouter.serve(BackendRoutes, {
  disableListenLog: true,
  disableLogger: true,
  routerConfig: { maxParamLength: 2048 },
}).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(GitHub.disabled),
  Layer.provideMerge(MediaBucket.memory(objects)),
  Layer.provideMerge(HistoryStore.layer),
  Layer.provideMerge(PgMigrationsLive),
  Layer.provideMerge(PgTestLive),
  Layer.provideMerge(NodeServices.layer),
);

/** git with fixed identity and dates, so commits line up with the session's actions. */
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

const STORE = [
  "export function saveThread(record) {",
  "  return store.put(record.id, record);",
  "}",
];
const CLIENT = [
  "export async function uploadThreads(api) {",
  "  await api.history.putThread();",
  "}",
];

/** A Codex session (`codex exec`) as its rollout file has it. */
const writeRollout = (
  codexHome: string,
  id: string,
  cwd: string,
  items: ReadonlyArray<{ at: string; item: object }>,
  meta: object = {},
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
        line(first, "session_meta", {
          id,
          timestamp: first,
          cwd,
          originator: "codex_exec",
          ...meta,
        }),
        line(first, "event_msg", { type: "task_started", turn_id: `${id}-t1` }),
        ...items.map(({ at, item }) =>
          line(at, "event_msg", { type: "item_completed", turn_id: `${id}-t1`, item }),
        ),
        line(items.at(-1)!.at, "event_msg", { type: "task_complete", turn_id: `${id}-t1` }),
      ].join("\n"),
    );
  });

/**
 * One agent turn wrote two files at once; the work was then committed as two commits (a stack
 * split from one change), half an hour later.
 */
const scenario = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repo = yield* tempDir("toolreader-history-");
  const home = yield* tempDir("toolreader-history-home-");
  const codexHome = path.join(home, ".codex");
  yield* git(repo, ["init", "-q", "-b", "main"]);
  yield* git(repo, ["remote", "add", "origin", "https://github.com/acme/app.git"]);
  yield* fs.writeFileString(path.join(repo, "README.md"), "hi\n");
  yield* git(repo, ["add", "README.md"]);
  yield* git(repo, ["commit", "-q", "-m", "init"], "2026-01-01T09:00:00Z");
  const init = yield* git(repo, ["rev-parse", "HEAD"]);
  for (const [file, lines, at] of [
    ["store.ts", STORE, "2026-01-01T10:30:00Z"],
    ["client.ts", CLIENT, "2026-01-01T10:31:00Z"],
  ] as const) {
    yield* fs.writeFileString(path.join(repo, file), `${lines.join("\n")}\n`);
    yield* git(repo, ["add", file]);
    yield* git(repo, ["commit", "-q", "-m", `feat: ${file}\n\nAgent-Session: codex:coder`], at);
  }
  yield* writeRollout(
    codexHome,
    "coder",
    repo,
    [
      {
        at: "2026-01-01T10:00:00.000Z",
        item: {
          type: "UserMessage",
          id: "u1",
          content: [{ type: "text", text: "Add the store and client" }],
        },
      },
      {
        at: "2026-01-01T10:01:00.000Z",
        item: {
          type: "FileChange",
          id: "f1",
          status: "completed",
          changes: {
            [path.join(repo, "store.ts")]: { type: "add", content: `${STORE.join("\n")}\n` },
            [path.join(repo, "client.ts")]: { type: "add", content: `${CLIENT.join("\n")}\n` },
          },
        },
      },
      {
        at: "2026-01-01T10:02:00.000Z",
        item: {
          type: "CommandExecution",
          id: "t1",
          command: ["/bin/zsh", "-lc", "vitest run"],
          cwd: repo,
          status: "completed",
          aggregated_output: "2 passed",
          exit_code: 0,
        },
      },
    ],
    { git: { commit_hash: init, branch: "main" }, cli_version: "0.130.0" },
  );
  return { repo, home, codexHome };
});

/** The real rollout reader, listing one more session in the repo that can't be read. */
const withUnreadable = Layer.effect(
  CodexRollouts,
  Effect.map(CodexRollouts, (real) =>
    CodexRollouts.of({
      ...real,
      list: Effect.map(real.list, (all) => [
        ...all,
        { ...all[0]!, id: "codex:broken", title: "Fix the flaky test" },
      ]),
      get: (id, labels) =>
        id === "broken"
          ? Effect.fail(new ThreadNotFound({ threadId: "codex:broken" }))
          : real.get(id, labels),
    }),
  ),
).pipe(Layer.provide(CodexRollouts.layer));

/** The sync over the real rollout reader (no T3), with `home` as the user's home. */
const services = (
  home: string,
  codexHome: string,
  rollouts = CodexRollouts.layer,
  codexBin = "codex",
) =>
  HistorySync.layer.pipe(
    Layer.provide(RepoSessions.layer),
    Layer.provide([rollouts, ClaudeTranscripts.layer]),
    Layer.provide([
      Layer.succeed(
        ServerConfig,
        ServerConfig.of({
          port: 0,
          home,
          dbPath: "/nonexistent/state.sqlite",
          codexBin,
          codexHome,
          claudeHome: "/nonexistent",
          labelsPath: "",
          userConfigPath: `${home}/.toolreader/config.json`,
          distDir: `${home}/dist`,
        }),
      ),
      ThreadStore.empty,
      CodexSessions.disabled,
      Layer.succeed(
        Labeler,
        Labeler.of({ forThread: () => Effect.succeed({}), label: () => Effect.die("unused") }),
      ),
    ]),
  );

describe("history sync", () => {
  it.layer(ServerLive, { timeout: 120_000 })((it) => {
    it.effect("reads each commit as it is: a subject can't inject options, a merge is itself", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { repo, home, codexHome } = yield* scenario;
        // A subject crafted to shift fields: its "parent" would reach git grep as an option.
        const crafted = "evil\u001f--open-files-in-pager=touch PWNED\u001fx";
        yield* fs.writeFileString(`${repo}/z.ts`, "export const harmless = 'nothing to see';\n");
        yield* git(repo, ["add", "z.ts"]);
        yield* git(repo, ["commit", "-q", "-m", crafted], "2026-01-01T11:00:00Z");
        yield* git(repo, ["switch", "-q", "-c", "side", "main~1"]);
        yield* git(repo, ["commit", "-q", "--allow-empty", "-m", "side"], "2026-01-01T11:01:00Z");
        yield* git(repo, ["switch", "-q", "main"]);
        yield* git(
          repo,
          ["merge", "-q", "--no-ff", "-m", "merge side", "side"],
          "2026-01-01T11:02:00Z",
        );
        const merge = yield* git(repo, ["rev-parse", "HEAD"]);
        const sync = (range: string) =>
          Effect.flatMap(HistorySync, (h) =>
            h.sync(repo, range, { source: "codex-rollouts", dryRun: true }),
          ).pipe(Effect.provide(services(home, codexHome)));
        const report = yield* sync("main~2..main^1");
        assert.deepStrictEqual(
          report.commits.map(({ record }) => record.subject),
          [crafted],
        );
        assert.isFalse(yield* fs.exists(`${repo}/PWNED`));
        // One merge, as itself: it adds no lines of its own.
        const one = yield* sync(`-1 ${merge}`);
        assert.deepStrictEqual(
          one.commits.map(({ record }) => [record.sha, record.novel]),
          [[merge, 0]],
        );
      }).pipe(Effect.scoped),
    );

    it.effect("keeps session trailers without content attribution, and sends the thread once", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { repo, home, codexHome } = yield* scenario;
        yield* Effect.gen(function* () {
          const history = yield* HistorySync;
          const dry = yield* history.sync(repo, "main~2..main", {
            source: "codex-rollouts",
            dryRun: true,
          });
          assert.deepStrictEqual(
            dry.commits.map(({ record }) => [
              record.subject,
              record.links.map((l) => [l.threadId, l.turns]),
              record.explained,
              record.novel,
            ]),
            [
              ["feat: store.ts", [["codex:coder", []]], 0, 2],
              ["feat: client.ts", [["codex:coder", []]], 0, 2],
            ],
          );

          const server = yield* HttpServer.HttpServer;
          const port = server.address._tag === "TcpAddress" ? server.address.port : 0;
          const token = yield* Effect.flatMap(HistoryStore, (s) => s.createToken("acme", "test"));
          yield* fs.makeDirectory(`${home}/.toolreader`, { recursive: true });
          yield* fs.writeFileString(
            `${home}/.toolreader/config.json`,
            encodeJson({
              backend: { url: `http://127.0.0.1:${port}`, token, workspace: "acme" },
            }),
          );
          const first = yield* history.sync(repo, "main~2..main", {
            source: "codex-rollouts",
            dryRun: false,
          });
          assert.deepStrictEqual([first.repo, first.sent, first.unchanged], ["acme/app", 1, 0]);
          const again = yield* history.sync(repo, "main~2..main", {
            source: "codex-rollouts",
            dryRun: false,
          });
          assert.deepStrictEqual([again.sent, again.unchanged], [0, 1]);

          const store = yield* inWorkspace("acme");
          const shas = (yield* git(repo, ["rev-list", "main~2..main"])).split("\n");
          const stored = yield* store.commits("acme/app", shas);
          assert.deepStrictEqual(stored.map((c) => c.links.length).sort(), [1, 1]);
          // Each link keeps the test its session ran after writing the commit's lines.
          assert.deepStrictEqual(
            stored.map((c) =>
              c.links[0]?.checks?.map((k) => [k.kind, k.outcome, k.basis, k.linesAfter]),
            ),
            [[["test", "passed", "exit code", 0]], [["test", "passed", "exit code", 0]]],
          );
          const [thread] = yield* store.threads(["codex:coder"]);
          // Sent redacted: the home directory reads `~`, never the temp path.
          assert.notInclude(encodeJson(thread), home);
          // With where it was read from (home as ~) and the digest of what was read.
          assert.strictEqual(thread?.origin?.reader, "codex-rollout");
          assert.match(thread?.origin?.file ?? "", /^sessions\/2026\/01\/01\/rollout-.*\.jsonl$/);
          assert.match(thread?.origin?.sha256 ?? "", /^[0-9a-f]{64}$/);
          // With how the session started, as its rollout recorded it.
          assert.deepStrictEqual(snapshotValues(thread!.snapshot!), {
            startCommit: yield* git(repo, ["rev-parse", "main~2"]),
            branch: "main",
            cwd: repo.replace(home, "~"),
            clientVersion: "0.130.0",
          });
          assert.strictEqual(thread?.snapshot?.provenance?.["startCommit"], "recorded");

          // Read back as the range's page.
          yield* fs.makeDirectory(`${home}/dist/site`, { recursive: true });
          yield* fs.writeFileString(
            `${home}/dist/site/index.html`,
            `<script>${SITE_DATA_MARKER}</script>`,
          );
          const { file, view } = yield* history.site(repo, "main~2..main", `${home}/page`);
          assert.deepStrictEqual(
            view.commits.map((c) => c.entry?.links.map((l) => [l.thread.id, l.via])),
            [[["codex:coder", "trailer"]], [["codex:coder", "trailer"]]],
          );
          // Searchable by what the session ran, cited to the entry.
          const found = yield* history.search(repo, "VITEST", { all: false, limit: 5 });
          assert.deepStrictEqual(
            found.hits.map((h) => [h.threadId, h.entryId, h.kind, h.status]),
            [["codex:coder", "t1", "test", "ok"]],
          );
          assert.include(hitLines(found.hits[0]!).at(-1)!, "cite codex:coder#t1@");
          // And read back through the citation search printed.
          const cite = hitLines(found.hits[0]!).at(-1)!.replace("  cite ", "");
          const shown = yield* history.show(repo, cite);
          assert.deepStrictEqual([shown.status, shown.entry?.id], ["ok", "t1"]);
          assert.match(evidenceLines(cite, shown).join("\n"), /test ok \(exit 0\).*vitest run/s);
          // A version the stored one doesn't start with.
          const wrongVersion = `${cite.slice(0, -1)}${cite.endsWith("0") ? "1" : "0"}`;
          assert.strictEqual(
            (yield* history.show(repo, wrongVersion)).status,
            "version-unavailable",
          );
          // The page shows each link's checks, read back from the backend.
          assert.deepStrictEqual(
            view.commits.map((c) => c.entry?.links[0]?.checks?.map((k) => k.outcome)),
            [["passed"], ["passed"]],
          );
          assert.include(yield* fs.readFileString(file), "Add the store and client");
          // The turn's edits are the commits' files: each attributed, not "untracked".
          assert.deepStrictEqual(
            view.commits.map((c) => c.entry?.files.map((f) => [f.path, f.bucket])),
            [[["store.ts", "attributed"]], [["client.ts", "attributed"]]],
          );

          // A review frozen: its commits' conclusions and the sessions they cite, at their versions.
          const frozen = yield* history.freezeReview(repo, "main~2..main", {
            verdict: "approved",
            note: "both halves of the split are covered",
          });
          assert.deepStrictEqual(
            [
              frozen.by,
              frozen.shas.length,
              frozen.commits.length,
              frozen.evidence.map((e) => e.threadId),
            ],
            ["test", 2, 2, ["codex:coder"]],
          );
          assert.strictEqual(frozen.methods.checks, "checks/2");
          const reopened = yield* history.review(repo, frozen.id);
          assert.deepStrictEqual(reopened.now, [{ threadId: "codex:coder", status: "same" }]);
          assert.deepStrictEqual(reopened.manifest.commits, frozen.commits);
          // The session deleted: the review reopens without what was drawn from it, and says so.
          yield* Effect.flatMap(HistoryStore, (s) => s.deleteThread("acme", "codex:coder"));
          const after = yield* history.review(repo, frozen.id);
          assert.deepStrictEqual(after.now, [{ threadId: "codex:coder", status: "deleted" }]);
          assert.deepStrictEqual(
            after.manifest.commits.map((c) => c.links.length),
            [0, 0],
          );
          assert.deepStrictEqual(after.manifest.removed, ["codex:coder"]);
          assert.deepStrictEqual(after.manifest.decision, frozen.decision);
        }).pipe(Effect.provide(services(home, codexHome)));
      }).pipe(Effect.scoped),
    );

    it.effect("does not link matching edits without an explicit declaration or trailer", () =>
      Effect.gen(function* () {
        const { repo, home, codexHome } = yield* scenario;
        yield* git(
          repo,
          ["commit", "--amend", "-q", "-m", "feat: client.ts"],
          "2026-01-01T10:31:00Z",
        );
        const report = yield* Effect.flatMap(HistorySync, (h) =>
          h.sync(repo, "-1 HEAD", { source: "codex-rollouts", dryRun: true }),
        ).pipe(Effect.provide(services(home, codexHome)));
        assert.deepStrictEqual(
          report.commits.map(({ record }) => [record.links, record.explained, record.novel]),
          [[[], 0, 2]],
        );
      }).pipe(Effect.scoped),
    );

    it.effect(
      "applies what an agent declared: a link to another session's turns, and an unlink",
      () =>
        Effect.gen(function* () {
          const { repo, home, codexHome } = yield* scenario;
          const [client, store] = (yield* git(repo, ["rev-list", "main~2..main"])).split("\n");
          // Another session split the work, and said where each commit came from.
          const declare = (id: string, script: string, output: string) => ({
            type: "CommandExecution",
            id,
            command: ["/bin/zsh", "-lc", script],
            cwd: repo,
            status: "completed",
            aggregated_output: output,
            exit_code: 0,
          });
          yield* writeRollout(codexHome, "splitter", repo, [
            {
              at: "2026-01-01T10:40:00.000Z",
              item: {
                type: "UserMessage",
                id: "s1",
                content: [{ type: "text", text: "Split it" }],
              },
            },
            {
              at: "2026-01-01T10:41:00.000Z",
              item: declare(
                "d1",
                "toolreader history link --sha HEAD~1 --session codex:coder --turns 1 --note 'wrote the store'",
                `history link: ${store} for HEAD~1`,
              ),
            },
            {
              at: "2026-01-01T10:42:00.000Z",
              item: declare(
                "d2",
                "npx toolreader history unlink --sha HEAD --session codex:coder",
                `history unlink: ${client} for HEAD`,
              ),
            },
          ]);
          const report = yield* Effect.flatMap(HistorySync, (h) =>
            h.sync(repo, "main~2..main", { source: "codex-rollouts", dryRun: true }),
          ).pipe(Effect.provide(services(home, codexHome)));
          assert.deepStrictEqual(
            report.commits.map(({ record }) =>
              record.links.map((l) => [l.threadId, l.via, l.turns, l.note, l.declaredBy]),
            ),
            [[["codex:coder", "asserted", ["u1"], "wrote the store", "codex:splitter"]], []],
          );
          assert.deepStrictEqual(report.ignored, []);
        }).pipe(Effect.scoped),
    );

    it.effect("links a commit a Codex subagent wrote, under its parent", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { repo, home, codexHome } = yield* scenario;
        const lines = ["export const retries = 3;"];
        yield* fs.writeFileString(path.join(repo, "retry.ts"), `${lines.join("\n")}\n`);
        yield* git(repo, ["add", "retry.ts"]);
        yield* git(
          repo,
          ["commit", "-q", "-m", "feat: retry\n\nAgent-Session: codex:worker"],
          "2026-01-01T11:00:00Z",
        );
        yield* writeRollout(
          codexHome,
          "worker",
          repo,
          [
            {
              at: "2026-01-01T10:50:00.000Z",
              item: {
                type: "FileChange",
                id: "w1",
                status: "completed",
                changes: {
                  [path.join(repo, "retry.ts")]: { type: "add", content: `${lines.join("\n")}\n` },
                },
              },
            },
          ],
          // As Codex writes a spawned agent's first line: its source and the session that spawned it.
          { source: { subagent: { other: "worker" } }, parent_thread_id: "coder" },
        );

        const report = yield* Effect.flatMap(HistorySync, (h) =>
          h.sync(repo, "main~1..main", { source: "codex-rollouts", dryRun: true }),
        ).pipe(Effect.provide(services(home, codexHome)));
        assert.deepStrictEqual(
          report.commits.map(({ record }) => record.links.map((l) => l.threadId)),
          [["codex:worker"]],
        );
      }).pipe(Effect.scoped),
    );

    it.effect(
      "sends a linked thread's subagents that changed nothing and ran elsewhere, and marks unchanged threads checked",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { repo, home, codexHome } = yield* scenario;
          // A QA pass the coder delegated: it only talked, from outside the repo.
          yield* writeRollout(
            codexHome,
            "qa",
            home,
            [
              {
                at: "2026-01-01T12:00:00.000Z",
                item: {
                  type: "UserMessage",
                  id: "q1",
                  content: [{ type: "text", text: "Check staging" }],
                },
              },
              {
                at: "2026-01-01T12:30:00.000Z",
                item: {
                  type: "AgentMessage",
                  id: "q2",
                  content: [{ type: "Text", text: "Staging checkout works" }],
                },
              },
            ],
            { source: { subagent: { other: "qa" } }, parent_thread_id: "coder" },
          );
          const server = yield* HttpServer.HttpServer;
          const port = server.address._tag === "TcpAddress" ? server.address.port : 0;
          const token = yield* Effect.flatMap(HistoryStore, (s) => s.createToken("family", "test"));
          yield* fs.makeDirectory(`${home}/.toolreader`, { recursive: true });
          yield* fs.writeFileString(
            `${home}/.toolreader/config.json`,
            encodeJson({
              backend: { url: `http://127.0.0.1:${port}`, token, workspace: "family" },
            }),
          );
          const sync = Effect.flatMap(HistorySync, (h) =>
            h.sync(repo, "main~2..main", { source: "codex-rollouts", dryRun: false }),
          ).pipe(Effect.provide(services(home, codexHome)));
          const first = yield* sync;
          assert.deepStrictEqual([first.sent, first.unchanged], [2, 0]);
          // Context, not authorship: the commits still link only the coder.
          assert.deepStrictEqual(
            first.commits.map(({ record }) => record.links.map((l) => l.threadId)),
            [["codex:coder"], ["codex:coder"]],
          );
          const store = yield* inWorkspace("family");
          const [qa] = yield* store.threads(["codex:qa"]);
          assert.strictEqual(qa?.thread.parent, "codex:coder");
          assert.deepStrictEqual(
            [qa?.lastEntryAt, qa?.sourceState],
            ["2026-01-01T12:30:00.000Z", "unknown"],
          );

          const sql = yield* SqlClient.SqlClient;
          const checkedAt = sql<{ readonly at: string }>`
            SELECT checked_at::text AS at FROM threads WHERE id = 'codex:coder'
              AND workspace_id = (SELECT id FROM workspaces WHERE slug = 'family')`.pipe(
            Effect.map((rows) => rows[0]!.at),
          );
          const before = yield* checkedAt;
          const again = yield* sync;
          assert.deepStrictEqual([again.sent, again.unchanged], [0, 2]);
          // Not resent, but confirmed as stored just now.
          assert.isAbove(Date.parse(yield* checkedAt), Date.parse(before));
        }).pipe(Effect.scoped),
    );

    it.effect("skips a thread the backend holds a newer copy of, or deleted, and says so", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { repo, home, codexHome } = yield* scenario;
        const server = yield* HttpServer.HttpServer;
        const port = server.address._tag === "TcpAddress" ? server.address.port : 0;
        const token = yield* Effect.flatMap(HistoryStore, (s) => s.createToken("newer", "test"));
        yield* fs.makeDirectory(`${home}/.toolreader`, { recursive: true });
        yield* fs.writeFileString(
          `${home}/.toolreader/config.json`,
          encodeJson({ backend: { url: `http://127.0.0.1:${port}`, token, workspace: "newer" } }),
        );
        const sync = Effect.flatMap(HistorySync, (h) =>
          h.sync(repo, "main~2..main", { source: "codex-rollouts", dryRun: false }),
        ).pipe(Effect.provide(services(home, codexHome)));
        const first = yield* sync;
        const store = yield* inWorkspace("newer");
        const [ours] = yield* store.threads(["codex:coder"]);
        // Another machine read the session later: one more entry, a later last one.
        yield* store.putThread({
          ...ours!,
          entries: [
            ...ours!.entries,
            {
              type: "message",
              id: "later",
              at: "2026-01-02T09:00:00.000Z",
              role: "user",
              text: "and later",
            },
          ],
          lastEntryAt: "2026-01-02T09:00:00.000Z",
        });
        assert.deepStrictEqual(first.skipped, []);
        const stale = yield* sync;
        assert.deepStrictEqual(
          [stale.sent, stale.unchanged, stale.skipped.map((k) => [k.id, k.why])],
          [0, 0, [["codex:coder", "newer"]]],
        );
        assert.include(
          reportLines(stale, false).join("\n"),
          "! skipped Add the store and client (codex:coder): backend has a newer copy",
        );
        // Still the newer copy.
        assert.strictEqual((yield* store.threads(["codex:coder"]))[0]?.entries.at(-1)?.id, "later");
        yield* Effect.flatMap(HistoryStore, (s) => s.deleteThread("newer", "codex:coder"));
        const deleted = yield* sync;
        assert.deepStrictEqual(
          deleted.skipped.map((k) => [k.id, k.why]),
          [["codex:coder", "deleted"]],
        );
        assert.include(reportLines(deleted, false).join("\n"), "deleted on request");
      }).pipe(Effect.scoped),
    );

    it.effect(
      "captures a stopped session: retries what was pending, pushes it, sends what it declared",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { repo, home, codexHome } = yield* scenario;
          const [client, store] = (yield* git(repo, ["rev-list", "main~2..main"])).split("\n");
          // A later session that changed no file, ran a check, and declared it tested the store.
          yield* writeRollout(codexHome, "checker", repo, [
            {
              at: "2026-01-01T13:00:00.000Z",
              item: {
                type: "UserMessage",
                id: "c1",
                content: [{ type: "text", text: "Check the store" }],
              },
            },
            {
              at: "2026-01-01T13:01:00.000Z",
              item: {
                type: "CommandExecution",
                id: "c2",
                command: ["/bin/zsh", "-lc", `toolreader history link --sha ${store!.slice(0, 8)}`],
                cwd: repo,
                status: "completed",
                aggregated_output: `history link: ${store} for ${store!.slice(0, 8)}`,
                exit_code: 0,
              },
            },
          ]);
          const server = yield* HttpServer.HttpServer;
          const port = server.address._tag === "TcpAddress" ? server.address.port : 0;
          const token = yield* Effect.flatMap(HistoryStore, (s) => s.createToken("stops", "test"));
          yield* fs.makeDirectory(`${home}/.toolreader/pending`, { recursive: true });
          yield* fs.writeFileString(
            `${home}/.toolreader/config.json`,
            encodeJson({ backend: { url: `http://127.0.0.1:${port}`, token, workspace: "stops" } }),
          );
          // A push whose sync failed before: waiting for the next hook.
          const common = yield* git(repo, [
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          ]);
          const config = Layer.succeed(
            ServerConfig,
            ServerConfig.of({
              port: 0,
              home,
              dbPath: "/nonexistent/state.sqlite",
              codexBin: "codex",
              codexHome,
              claudeHome: "/nonexistent",
              labelsPath: "",
              userConfigPath: `${home}/.toolreader/config.json`,
              distDir: `${home}/dist`,
            }),
          );
          yield* Effect.flatMap(pending(common), (p) =>
            p.failed(`-1 ${client}`, "CONNECTION_REFUSED"),
          ).pipe(Effect.provide(config));
          assert.lengthOf(yield* fs.readDirectory(path.join(home, ".toolreader", "pending")), 1);
          const lines = yield* capture(repo, "codex:checker").pipe(
            Effect.provide([services(home, codexHome), config]),
          );
          assert.isFalse(
            lines.some((l) => l.startsWith("✗")),
            lines.join("\n"),
          );
          // A session this repo doesn't know (a Codex subagent's own id): nothing, quietly.
          assert.deepStrictEqual(
            yield* capture(repo, "codex:unknown").pipe(
              Effect.provide([services(home, codexHome), config]),
            ),
            [],
          );
          assert.deepStrictEqual(
            yield* fs.readDirectory(path.join(home, ".toolreader", "pending")),
            [],
          );
          const ws = yield* inWorkspace("stops");
          assert.deepStrictEqual(
            (yield* ws.threads(["codex:checker", "codex:coder"])).map((t) => t.thread.id).sort(),
            ["codex:checker", "codex:coder"],
          );
          // The retried push's commit, and the one the session declared.
          const linked = new Map(
            (yield* ws.commits("acme/app", [client!, store!])).map((c) => [
              c.sha,
              c.links.map((l) => [l.threadId, l.via]),
            ]),
          );
          assert.deepStrictEqual(linked.get(client!), [["codex:coder", "trailer"]]);
          assert.deepStrictEqual(linked.get(store!), [
            ["codex:checker", "asserted"],
            ["codex:coder", "trailer"],
          ]);
        }).pipe(Effect.scoped),
    );

    it.effect("pushes a session by id with its subagents, linked to no commit", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { repo, home, codexHome } = yield* scenario;
        yield* writeRollout(
          codexHome,
          "worker",
          repo,
          [
            {
              at: "2026-01-01T10:50:00.000Z",
              item: {
                type: "CommandExecution",
                id: "w1",
                command: ["/bin/zsh", "-lc", "open http://localhost:3111/withdrawals"],
                cwd: repo,
                status: "completed",
                aggregated_output: "",
                exit_code: 0,
              },
            },
          ],
          { source: { subagent: { other: "worker" } }, parent_thread_id: "coder" },
        );
        const server = yield* HttpServer.HttpServer;
        const port = server.address._tag === "TcpAddress" ? server.address.port : 0;
        const token = yield* Effect.flatMap(HistoryStore, (s) => s.createToken("pushed", "test"));
        yield* fs.makeDirectory(`${home}/.toolreader`, { recursive: true });
        yield* fs.writeFileString(
          `${home}/.toolreader/config.json`,
          encodeJson({
            backend: { url: `http://127.0.0.1:${port}`, token, workspace: "pushed" },
          }),
        );
        const report = yield* Effect.flatMap(HistorySync, (h) =>
          h.push(repo, ["codex:coder"], "codex-rollouts"),
        ).pipe(Effect.provide(services(home, codexHome)));
        assert.deepStrictEqual(
          report.threads.map((t) => [t.id, t.parent]),
          [
            ["codex:coder", null],
            ["codex:worker", "codex:coder"],
          ],
        );
        assert.deepStrictEqual([report.sent, report.unchanged], [2, 0]);
        const store = yield* inWorkspace("pushed");
        const [worker] = yield* store.threads(["codex:worker"]);
        assert.strictEqual(worker?.thread.parent, "codex:coder");
        const missing = yield* Effect.flip(
          Effect.flatMap(HistorySync, (h) => h.push(repo, ["codex:nope"], "codex-rollouts")),
        ).pipe(Effect.provide(services(home, codexHome)));
        assert.include(missing.message, "No session codex:nope");
      }).pipe(Effect.scoped),
    );

    it.effect("writes a stored image to a file, only when its bytes hash to its name", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* tempDir("toolreader-media-");
        const server = yield* HttpServer.HttpServer;
        const port = server.address._tag === "TcpAddress" ? server.address.port : 0;
        const token = yield* Effect.flatMap(HistoryStore, (s) => s.createToken("shots", "test"));
        yield* Effect.flatMap(HistoryStore, (s) => s.setMedia("shots", true));
        const settings = { url: `http://127.0.0.1:${port}`, token, workspace: "shots" };
        yield* fs.makeDirectory(`${home}/.toolreader`, { recursive: true });
        yield* fs.writeFileString(
          `${home}/.toolreader/config.json`,
          encodeJson({ backend: settings }),
        );
        const bytes = Buffer.from("a screenshot for the CLI");
        const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
        const api = yield* connect({ ...settings, token: Redacted.make(token) });
        yield* api.history.putMedia({
          params: { ws: "shots" },
          payload: { sha256, mime: "image/jpeg", data: bytes.toString("base64") },
        });
        const config = Layer.succeed(
          ServerConfig,
          ServerConfig.of({
            port: 0,
            home,
            dbPath: "/nonexistent/state.sqlite",
            codexBin: "codex",
            codexHome: "/nonexistent",
            claudeHome: "/nonexistent",
            labelsPath: "",
            userConfigPath: `${home}/.toolreader/config.json`,
            distDir: `${home}/dist`,
          }),
        );
        const save = (sha: string, out?: string) =>
          saveMedia(sha, out).pipe(Effect.provide(config));

        const saved = yield* save(sha256, `${home}/shot.jpeg`);
        assert.deepStrictEqual(saved, {
          path: `${home}/shot.jpeg`,
          mime: "image/jpeg",
          bytes: bytes.length,
        });
        assert.deepStrictEqual(Buffer.from(yield* fs.readFile(saved.path)), bytes);

        assert.include((yield* Effect.flip(save("nope"))).message, "64 hex characters");
        assert.include((yield* Effect.flip(save("1".repeat(64)))).message, "NotFound");
        const key = [...objects.keys()].find((k) => k.endsWith(sha256))!;
        objects.set(key, Buffer.from("something else"));
        assert.include((yield* Effect.flip(save(sha256))).message, "don't hash to");
      }).pipe(Effect.provide(FetchHttpClient.layer), Effect.scoped),
    );

    it.effect("finds a failure two sessions hit, and keeps the decision on it", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { repo, home, codexHome } = yield* scenario;
        // Two more sessions, each writing a file the next commits hold, each tripping on `vp`.
        for (const [id, file, at] of [
          ["one", "one.ts", "11:00"],
          ["two", "two.ts", "12:00"],
        ] as const) {
          const content = `export const ${id}Handler = () => "${id} handled here";\n`;
          yield* writeRollout(codexHome, id, repo, [
            {
              at: `2026-01-01T${at}:00.000Z`,
              item: {
                type: "CommandExecution",
                id: `${id}-fail`,
                command: ["/bin/zsh", "-lc", "vp test"],
                cwd: repo,
                status: "failed",
                aggregated_output: "zsh:1: command not found: vp",
                exit_code: 127,
              },
            },
            {
              at: `2026-01-01T${at}:30.000Z`,
              item: {
                type: "FileChange",
                id: `${id}-edit`,
                status: "completed",
                changes: { [path.join(repo, file)]: { type: "add", content } },
              },
            },
          ]);
          yield* fs.writeFileString(path.join(repo, file), content);
          yield* git(repo, ["add", file]);
          yield* git(
            repo,
            ["commit", "-q", "-m", `feat: ${file}\n\nAgent-Session: codex:${id}`],
            `2026-01-01T${at}:59Z`,
          );
        }
        yield* Effect.gen(function* () {
          const history = yield* HistorySync;
          const server = yield* HttpServer.HttpServer;
          const port = server.address._tag === "TcpAddress" ? server.address.port : 0;
          const token = yield* Effect.flatMap(HistoryStore, (s) => s.createToken("acme-i", "ci"));
          yield* fs.makeDirectory(`${home}/.toolreader`, { recursive: true });
          yield* fs.writeFileString(
            `${home}/.toolreader/config.json`,
            encodeJson({
              backend: { url: `http://127.0.0.1:${port}`, token, workspace: "acme-i" },
            }),
          );
          yield* history.sync(repo, "main~2..main", { source: "codex-rollouts", dryRun: false });

          const first = yield* history.insights(repo, { detect: true, statuses: ["detected"] });
          const failure = first.findings.find((f) => f.detector === "recurring-failure");
          assert.deepStrictEqual(
            [failure?.subject, failure?.sessions, first.added! > 0],
            ["test: zsh:#: command not found: vp", 2, true],
          );
          const decided = yield* history.decide(repo, failure!.id, "rejected", "known: use npx vp");
          assert.deepStrictEqual(
            decided.events.map((e) => [e.to, e.by, e.why]),
            [["rejected", "ci", "known: use npx vp"]],
          );
          // Run again: nothing new, and the rejected one stays out of what's open.
          const again = yield* history.insights(repo, { detect: true, statuses: ["detected"] });
          assert.strictEqual(again.added, 0);
          assert.isFalse(again.findings.some((f) => f.id === failure!.id));
          const wrong = yield* history
            .decide(repo, failure!.id, "evaluated", "x")
            .pipe(Effect.flip);
          assert.include(wrong.message, "Conflict");
        }).pipe(Effect.provide(services(home, codexHome)));
      }).pipe(Effect.scoped),
    );

    it.effect("keeps an agent's cited finding, and refuses one citing what isn't there", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { repo, home, codexHome } = yield* scenario;
        yield* Effect.gen(function* () {
          const history = yield* HistorySync;
          const server = yield* HttpServer.HttpServer;
          const port = server.address._tag === "TcpAddress" ? server.address.port : 0;
          const token = yield* Effect.flatMap(HistoryStore, (s) =>
            s.createToken("acme-a", "agent"),
          );
          yield* fs.makeDirectory(`${home}/.toolreader`, { recursive: true });
          yield* fs.writeFileString(
            `${home}/.toolreader/config.json`,
            encodeJson({
              backend: { url: `http://127.0.0.1:${port}`, token, workspace: "acme-a" },
            }),
          );
          yield* history.sync(repo, "main~2..main", { source: "codex-rollouts", dryRun: false });
          // What an agent investigating would cite: an edit search found, at its version, quoting
          // the words in it that show the claim (here the edit's own title, spaced otherwise).
          const [hit] = (yield* history.search(repo, undefined, {
            all: false,
            limit: 1,
            kinds: ["edit"],
          })).hits;
          const quote = ` ${hit!.title.toUpperCase().split(" ").join("   ")} `;
          const submission = {
            subject: "Handler registration",
            pattern: "The session looked for where handlers are registered before writing one.",
            suggestion: "Say in AGENTS.md where handlers are registered.",
            citations: [
              { threadId: hit!.threadId, entryId: hit!.entryId, version: hit!.version, quote },
            ],
          };
          const first = yield* history.submit(repo, submission);
          assert.deepStrictEqual(
            [first.added, first.finding.detector, first.finding.status, first.finding.by],
            [true, "agent", "detected", "agent"],
          );
          // Kept as the entry has it, so the page can mark it there.
          assert.deepStrictEqual(
            first.finding.occurrences.map((o) => [o.entryId, o.version, o.quote]),
            [[hit!.entryId, hit!.version, hit!.title]],
          );
          // The same subject, cased and spaced otherwise, is the same finding.
          const again = yield* history.submit(repo, {
            ...submission,
            subject: "  handler   REGISTRATION ",
          });
          assert.deepStrictEqual([again.added, again.finding.id], [false, first.finding.id]);
          // A detector run leaves it alone.
          const listed = yield* history.insights(repo, { detect: true });
          assert.isTrue(listed.findings.some((f) => f.id === first.finding.id));
          const refused = yield* history
            .submit(repo, {
              ...submission,
              citations: [{ threadId: hit!.threadId, entryId: "nope", quote }],
            })
            .pipe(Effect.flip);
          assert.include(refused.message, `${hit!.threadId}#nope (missing)`);
          // A quote that isn't in the cited entry refuses the finding too.
          const misquoted = yield* history
            .submit(repo, {
              ...submission,
              citations: [{ ...submission.citations[0]!, quote: "tests all passed" }],
            })
            .pipe(Effect.flip);
          assert.include(misquoted.message, `quote not in the entry: "tests all passed"`);
        }).pipe(Effect.provide(services(home, codexHome, CodexRollouts.layer)));
      }).pipe(Effect.scoped),
    );

    it.effect("reports a session it couldn't read instead of dropping it", () =>
      Effect.gen(function* () {
        const { repo, home, codexHome } = yield* scenario;
        const report = yield* Effect.flatMap(HistorySync, (h) =>
          h.sync(repo, "main~2..main", { source: "codex-rollouts", dryRun: true }),
        ).pipe(Effect.provide(services(home, codexHome, withUnreadable)));
        assert.deepStrictEqual(report.unread, [
          { id: "codex:broken", title: "Fix the flaky test" },
        ]);
        // The sessions that could be read are still linked.
        assert.deepStrictEqual(
          report.commits.map(({ record }) => record.links.map((l) => l.threadId)),
          [["codex:coder"], ["codex:coder"]],
        );
        assert.include(
          reportLines(report, true),
          "! couldn't read codex:broken (Fix the flaky test)",
        );
      }).pipe(Effect.scoped),
    );
  });
});
