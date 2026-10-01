import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schedule from "effect/Schedule";

import { CodexSessions } from "./CodexSessions.ts";
import { ServerConfig } from "./ServerConfig.ts";
import { ThreadStore } from "./ThreadStore.ts";

// Stands in for `codex app-server`: newline-delimited JSON-RPC over stdio with canned threads.
const fakeAppServer = (rolloutPath: string, NOW_S: number) => `#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
const meta = (id, extra) => ({ id, preview: "do " + id + "\\nsecond line", cwd: "/work/repo/sub", path: ${JSON.stringify(rolloutPath)}, createdAt: ${NOW_S - 1000}, updatedAt: ${NOW_S - 500}, originator: "codex-tui", ...extra });
const threads = [
  meta("mine"),
  meta("owned-by-t3", { originator: "t3code_desktop" }),
  meta("child", { parentThreadId: "mine" }),
  meta("fresh", { updatedAt: ${NOW_S}, cwd: "/elsewhere/app" }),
];
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
rl.on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") return send({ id, result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "macos" } });
  if (method === "thread/list") return send({ id, result: { data: params.archived ? [] : threads, nextCursor: null } });
  if (method === "thread/read") {
    if (params.threadId !== "mine") return send({ id, error: { code: -32600, message: "thread not found" } });
    return send({ id, result: { thread: { ...meta("mine"), turns: [{ id: "turn1", startedAt: ${NOW_S - 900}, items: [
      { type: "userMessage", id: "u1", content: [{ type: "text", text: "do mine" }] },
      { type: "commandExecution", id: "c1", status: "completed", command: "rg -n foo src", exitCode: 0 },
    ] }] } } });
  }
  send({ id, error: { code: -32601, message: "unknown method " + method } });
});
`;

const ROLLOUT = [
  '{"timestamp":"2026-01-01T00:00:01.000Z","type":"response_item","payload":{"type":"message","id":"u1"}}',
  '{"timestamp":"2026-01-01T00:00:02.000Z","type":"response_item","payload":{"type":"function_call","call_id":"c1"}}',
].join("\n");

const withSessions = <A, E>(
  codexBin: (
    dir: string,
  ) => Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path>,
  use: (codex: CodexSessions["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "toolreader-codex-" });
    const bin = yield* codexBin(dir);
    const config = Layer.succeed(
      ServerConfig,
      ServerConfig.of({
        port: 0,
        home: "/home/me",
        dbPath: "",
        codexBin: bin,
        labelsPath: "",
        distDir: "",
      }),
    );
    const store = Layer.succeed(
      ThreadStore,
      ThreadStore.of({
        list: Effect.succeed([]),
        get: () => Effect.die("unused"),
        head: () => Effect.die("unused"),
        codexThreadIds: Effect.succeed(new Set(["owned-by-t3"])),
        projects: Effect.succeed([{ id: "p1", title: "repo", root: "/work/repo" }]),
      }),
    );
    return yield* Effect.flatMap(CodexSessions, use).pipe(
      Effect.provide(CodexSessions.layer.pipe(Layer.provide([config, store]))),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const fakeBin = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const nowS = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const rollout = path.join(dir, "rollout.jsonl");
    yield* fs.writeFileString(rollout, ROLLOUT);
    const bin = path.join(dir, "codex.cjs");
    // The real binary takes `app-server` as its first argument; the fake ignores it.
    yield* fs.writeFileString(bin, fakeAppServer(rollout, nowS));
    yield* fs.chmod(bin, 0o755);
    return bin;
  });

/** The first thread/list runs in the background; wait until it has landed. */
const listLoaded = (codex: CodexSessions["Service"]) =>
  codex.list.pipe(
    Effect.filterOrFail(
      (l) => l.length > 0,
      () => new Cause.NoSuchElementError(),
    ),
    Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 100 }),
  );

describe("CodexSessions", () => {
  it.live("lists top-level sessions not owned by T3, grouped into T3 projects by cwd", () =>
    withSessions(fakeBin, (codex) =>
      Effect.gen(function* () {
        const list = yield* listLoaded(codex);
        assert.deepStrictEqual(
          [...list]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((t) => [t.id, t.title, t.projectId, t.projectTitle, t.origin, t.status, t.source]),
          [
            [
              "codex:fresh",
              "do fresh",
              "cwd:/elsewhere/app",
              "app",
              "codex-tui",
              "running",
              "codex",
            ],
            ["codex:mine", "do mine", "p1", "repo", "codex-tui", "idle", "codex"],
          ],
        );
      }),
    ),
  );

  it.live("reads a thread with rollout timestamps and reports missing ones as ThreadNotFound", () =>
    withSessions(fakeBin, (codex) =>
      Effect.gen(function* () {
        yield* listLoaded(codex);
        const view = yield* codex.get("mine", {});
        assert.deepStrictEqual(
          view.entries.map((e) => [e.type, e.at, e.type === "action" ? e.title : ""]),
          [
            ["message", "2026-01-01T00:00:01.000Z", ""],
            ["action", "2026-01-01T00:00:02.000Z", 'search "foo" in src'],
          ],
        );
        assert.strictEqual(view.thread.actionCount, 1);
        assert.notStrictEqual((yield* codex.head("mine")).head, "");
        const error = yield* Effect.flip(codex.get("nope", {}));
        assert.strictEqual(error.threadId, "codex:nope");
      }),
    ),
  );

  it.live("disables the source instead of failing when codex can't start", () =>
    withSessions(
      (dir) => Effect.succeed(`${dir}/no-such-codex`),
      (codex) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* codex.list, []);
          assert.strictEqual((yield* Effect.flip(codex.get("x", {})))._tag, "ThreadNotFound");
        }),
    ),
  );
});
