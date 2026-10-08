import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ThreadView } from "../core/domain.ts";
import { CodexSessions } from "./CodexSessions.ts";
import { Labeler } from "./Labeler.ts";
import { Proofs } from "./Proofs.ts";
import { ServerConfig } from "./ServerConfig.ts";
import { ThreadStore } from "./ThreadStore.ts";

const SECRET = "API_TOKEN=supersecret";

const view: ThreadView = {
  thread: {
    id: "t1",
    source: "t3",
    origin: null,
    // T3 titles threads from the first prompt line.
    title: `Use ${SECRET} to fix this`,
    projectId: "p",
    projectTitle: "repo",
    provider: "codex",
    status: "idle",
    archived: false,
    updatedAt: "2026-01-01T10:00:00Z",
    actionCount: 1,
    worktree: null,
    head: "h",
  },
  entries: [
    { type: "message", id: "u1", at: "2026-01-01T10:00:00Z", role: "user", text: `Use ${SECRET}` },
  ],
  labels: { u1: `Asked to use ${SECRET}` },
};

describe("Proofs", () => {
  it.effect("redacts the thread title and labels like the entries", () =>
    Effect.gen(function* () {
      const proofs = yield* Proofs;
      const json = yield* proofs.render(
        yield* proofs.build({ threadId: "t1", scope: { turns: null, range: null }, outputs: true }),
      );
      assert.notInclude(json, "supersecret");
      assert.include(json, "API_TOKEN=[redacted]");
    }).pipe(
      Effect.provide(
        Proofs.layer.pipe(
          Layer.provide([
            Layer.succeed(
              ServerConfig,
              ServerConfig.of({
                port: 0,
                home: "/home/me",
                dbPath: "",
                codexBin: "codex",
                codexHome: "/home/me/.codex",
                labelsPath: "",
                userConfigPath: "",
                distDir: "",
              }),
            ),
            Layer.succeed(
              ThreadStore,
              ThreadStore.of({
                list: Effect.succeed([]),
                get: () => Effect.succeed(view),
                head: () => Effect.die("unused"),
                codexThreadIds: Effect.succeed(new Set()),
                lineage: Effect.succeed({ nativeIds: new Map(), parents: new Map() }),
                projects: Effect.succeed([]),
              }),
            ),
            CodexSessions.disabled,
            Layer.succeed(
              Labeler,
              Labeler.of({
                forThread: () => Effect.succeed({}),
                label: () => Effect.die("unused"),
              }),
            ),
          ]),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );
});
