import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { snapshotValues } from "../core/domain.ts";
import { ClaudeTranscripts } from "./ClaudeTranscripts.ts";
import { ServerConfig } from "./ServerConfig.ts";
import { ThreadStore } from "./ThreadStore.ts";

/** A transcript; a subagent's own file has every line on the sidechain. */
const session = (id: string, cwd: string, isSidechain = false) =>
  [
    { type: "ai-title", aiTitle: `title ${id}`, sessionId: id },
    {
      type: "user",
      sessionId: id,
      cwd,
      gitBranch: "main",
      uuid: "u1",
      timestamp: "2026-10-07T12:00:00.000Z",
      message: { content: "list files" },
    },
    {
      type: "assistant",
      sessionId: id,
      cwd,
      uuid: "a1",
      timestamp: "2026-10-07T12:00:01.000Z",
      message: {
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
      },
    },
    {
      type: "user",
      sessionId: id,
      cwd,
      uuid: "u2",
      timestamp: "2026-10-07T12:00:02.000Z",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a.ts" }] },
    },
  ]
    .map((l) => JSON.stringify({ ...l, isSidechain }))
    .join("\n") + "\n";

describe("ClaudeTranscripts", () => {
  it.live("lists sessions T3 doesn't own and reads one into entries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "toolreader-claude-" });
      const dir = path.join(home, "projects", "-repo");
      yield* fs.makeDirectory(path.join(dir, "free", "subagents"), { recursive: true });
      const free = path.join(dir, "free.jsonl");
      yield* fs.writeFileString(free, session("free", "/repo"));
      yield* fs.writeFileString(path.join(dir, "owned.jsonl"), session("owned", "/repo"));
      yield* fs.writeFileString(
        path.join(dir, "free", "subagents", "agent-1.jsonl"),
        session("free", "/repo", true),
      );

      const layer = ClaudeTranscripts.layer.pipe(
        Layer.provide([
          Layer.succeed(
            ServerConfig,
            ServerConfig.of({
              port: 0,
              home: "/home/me",
              dbPath: "",
              codexBin: "codex",
              codexHome: "/nonexistent",
              claudeHome: home,
              labelsPath: "",
              userConfigPath: "",
              distDir: "",
            }),
          ),
          Layer.succeed(
            ThreadStore,
            ThreadStore.of({
              list: Effect.succeed([]),
              get: () => Effect.die("unused"),
              head: () => Effect.die("unused"),
              codexThreadIds: Effect.succeed(new Set()),
              claudeSessionIds: Effect.succeed(new Set(["owned"])),
              lineage: Effect.succeed({ nativeIds: new Map(), parents: new Map() }),
              projects: Effect.succeed([]),
            }),
          ),
          NodeServices.layer,
        ]),
      );

      yield* Effect.gen(function* () {
        const claude = yield* ClaudeTranscripts;
        const list = yield* claude.list;
        assert.deepStrictEqual(
          list.map((s) => [s.id, s.source, s.title, s.worktree]),
          [["claude:free", "claude", "title free", "/repo"]],
        );

        const view = yield* claude.get("free", {});
        assert.strictEqual(view.thread.actionCount, 1);
        assert.deepStrictEqual(
          view.entries.map((e) => (e.type === "action" ? [e.kind, e.title, e.output] : [e.type])),
          [["message"], ["search", "list .", "a.ts"]],
        );

        // The marker moves while the session writes.
        yield* fs.writeFileString(free, session("free", "/repo") + session("free", "/repo"));
        assert.notStrictEqual((yield* claude.head("free")).head, view.thread.head);

        // Subagents are listed apart, with their parent, and read as their own work.
        assert.deepStrictEqual(
          (yield* claude.subagents).map((s) => [s.summary.id, s.parent, s.summary.worktree]),
          [["claude:agent-1", "claude:free", "/repo"]],
        );
        const sub = yield* claude.get("agent-1", {});
        assert.strictEqual(sub.thread.actionCount, 1);
        // Named without the project folder, which spells the session's directory.
        assert.strictEqual(sub.origin?.file, "free/subagents/agent-1.jsonl");
        assert.strictEqual(view.origin?.file, "free.jsonl");

        const missing = yield* claude.get("owned", {}).pipe(Effect.flip);
        assert.strictEqual(missing._tag, "ThreadNotFound");
        // T3 keeps no starting state, so a session it runs is still read for that.
        assert.deepStrictEqual(snapshotValues((yield* claude.snapshot("owned"))!), {
          branch: "main",
          cwd: "/repo",
        });
        assert.isNull(yield* claude.snapshot("nowhere"));
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
