import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { findCommitActions } from "../core/ledger.ts";
import { CodexRollouts } from "./CodexRollouts.ts";
import { CodexSessions } from "./CodexSessions.ts";
import { ServerConfig } from "./ServerConfig.ts";
import { ThreadStore } from "./ThreadStore.ts";

const ID = "01a0f7a1-d93a-77b1-b192-7c9ad47b7439";

// Stands in for `codex app-server`: serves what the real one returned for the fixture session
// (fixtures/codex-exec.thread-read.json), pointing `path` at the copied rollout.
const fakeAppServer = (readJson: string, rollout: string) => `#!/usr/bin/env node
const fs = require("node:fs");
const read = JSON.parse(fs.readFileSync(${JSON.stringify(readJson)}, "utf8"));
read.thread.path = ${JSON.stringify(rollout)};
const { turns, ...meta } = read.thread;
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") return send({ id, result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "macos" } });
  if (method === "thread/list") return send({ id, result: { data: [meta], nextCursor: null } });
  if (method === "thread/read") return send({ id, result: read });
  send({ id, error: { code: -32601, message: method } });
});
`;

describe("CodexRollouts", () => {
  it.live("reads a session from its rollout file into the same entries as codex app-server", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixtures = path.join(import.meta.dirname, "fixtures");
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "toolreader-rollouts-" });
      const codexHome = path.join(dir, "codex");
      const sessions = path.join(codexHome, "sessions", "2026", "10", "01");
      yield* fs.makeDirectory(sessions, { recursive: true });
      const rollout = path.join(sessions, `rollout-2026-10-01T15-22-54-${ID}.jsonl`);
      yield* fs.copyFile(path.join(fixtures, "codex-exec.rollout.jsonl"), rollout);
      const bin = path.join(dir, "codex.cjs");
      yield* fs.writeFileString(
        bin,
        fakeAppServer(path.join(fixtures, "codex-exec.thread-read.json"), rollout),
      );
      yield* fs.chmod(bin, 0o755);

      const config = Layer.succeed(
        ServerConfig,
        ServerConfig.of({
          port: 0,
          home: "/home/dev",
          dbPath: "",
          codexBin: bin,
          codexHome,
          claudeHome: "/nonexistent",
          labelsPath: "",
          userConfigPath: "",
          distDir: "",
        }),
      );
      const deps = Layer.mergeAll(config, ThreadStore.empty);
      yield* Effect.gen(function* () {
        const rollouts = yield* CodexRollouts;
        const appServer = yield* CodexSessions;

        const [listed] = yield* rollouts.list;
        assert.deepStrictEqual(
          [listed?.id, listed?.worktree, listed?.origin],
          [`codex:${ID}`, "/home/dev/proj/toolreader-demo", "codex_exec"],
        );

        const fromRollout = yield* rollouts.get(ID, {});
        yield* appServer.ready;
        const fromAppServer = yield* appServer.get(ID, {});
        assert.deepStrictEqual(fromRollout.entries, fromAppServer.entries);
        assert.strictEqual(findCommitActions(fromRollout.entries).length, 4);
        assert.strictEqual(fromRollout.thread.title, fromAppServer.thread.title);
        assert.strictEqual((yield* Effect.flip(rollouts.get("nope", {})))._tag, "ThreadNotFound");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            CodexRollouts.layer,
            CodexSessions.layerWith({
              initTimeout: "10 seconds",
              requestTimeout: "5 seconds",
              refreshEvery: "1 hour",
              fullRefreshEvery: 1,
            }),
          ).pipe(Layer.provide(deps)),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
