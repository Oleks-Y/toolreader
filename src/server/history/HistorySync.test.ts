// `history sync` end to end: a real git repo, a Codex session's rollout file, and the real backend
// (a test server on 127.0.0.1 over Docker Postgres).
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ThreadNotFound } from "../../core/api.ts";
import { SITE_DATA_MARKER } from "../../core/ledgerSite.ts";
import { BackendRoutes } from "../backend/Backend.ts";
import { HistoryStore } from "../backend/HistoryStore.ts";
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
import { reportLines } from "./historyCli.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const ServerLive = HttpRouter.serve(BackendRoutes, {
  disableListenLog: true,
  disableLogger: true,
  routerConfig: { maxParamLength: 2048 },
}).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
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
  for (const [file, lines, at] of [
    ["store.ts", STORE, "2026-01-01T10:30:00Z"],
    ["client.ts", CLIENT, "2026-01-01T10:31:00Z"],
  ] as const) {
    yield* fs.writeFileString(path.join(repo, file), `${lines.join("\n")}\n`);
    yield* git(repo, ["add", file]);
    yield* git(repo, ["commit", "-q", "-m", `feat: ${file}`], at);
  }
  yield* writeRollout(codexHome, "coder", repo, [
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
  ]);
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
const services = (home: string, codexHome: string, rollouts = CodexRollouts.layer) =>
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
          codexBin: "codex",
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

    it.effect(
      "links each commit of a split to the turn that wrote it, and sends the thread once",
      () =>
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
                ["feat: store.ts", [["codex:coder", ["u1"]]], 2, 2],
                ["feat: client.ts", [["codex:coder", ["u1"]]], 2, 2],
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
            assert.deepStrictEqual(
              (yield* store.commits("acme/app", shas)).map((c) => c.links.length).sort(),
              [1, 1],
            );
            const [thread] = yield* store.threads(["codex:coder"]);
            // Sent redacted: the home directory reads `~`, never the temp path.
            assert.notInclude(encodeJson(thread), home);

            // Read back as the range's page.
            yield* fs.makeDirectory(`${home}/dist/site`, { recursive: true });
            yield* fs.writeFileString(
              `${home}/dist/site/index.html`,
              `<script>${SITE_DATA_MARKER}</script>`,
            );
            const { file, view } = yield* history.site(repo, "main~2..main", `${home}/page`);
            assert.deepStrictEqual(
              view.commits.map((c) => c.entry?.links.map((l) => [l.thread.id, l.via])),
              [[["codex:coder", "content"]], [["codex:coder", "content"]]],
            );
            assert.include(yield* fs.readFileString(file), "Add the store and client");
            // The turn's edits are the commits' files: each attributed, not "untracked".
            assert.deepStrictEqual(
              view.commits.map((c) => c.entry?.files.map((f) => [f.path, f.bucket])),
              [[["store.ts", "attributed"]], [["client.ts", "attributed"]]],
            );
          }).pipe(Effect.provide(services(home, codexHome)));
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
        yield* git(repo, ["commit", "-q", "-m", "feat: retry"], "2026-01-01T11:00:00Z");
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
