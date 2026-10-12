// Ranges a hook couldn't sync, waiting for the next hook in the same repository.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../ServerConfig.ts";
import { pending } from "./historyHooks.ts";

const configAt = (home: string) =>
  Layer.succeed(
    ServerConfig,
    ServerConfig.of({
      port: 0,
      home,
      dbPath: "",
      codexBin: "codex",
      codexHome: "",
      claudeHome: "",
      labelsPath: "",
      userConfigPath: "",
      distDir: "",
    }),
  );

describe("pending syncs", () => {
  it.effect("keeps every range two hooks add at once, per repository, until it's done", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "toolreader-pending-" });
      yield* Effect.gen(function* () {
        const a = yield* pending("/repos/a/.git");
        const b = yield* pending("/repos/b/.git");
        yield* Effect.all([a.add("x1..x2"), a.add("y1..y2"), b.add("z1..z2")], {
          concurrency: "unbounded",
        });
        assert.deepStrictEqual((yield* a.list).sort(), ["x1..x2", "y1..y2"]);
        yield* a.done("x1..x2");
        assert.deepStrictEqual(yield* a.list, ["y1..y2"]);
        assert.deepStrictEqual(yield* b.list, ["z1..z2"]);
        const [file] = yield* fs.readDirectory(`${home}/.toolreader/pending`);
        assert.strictEqual(
          (yield* fs.stat(`${home}/.toolreader/pending/${file}`)).mode & 0o777,
          0o600,
        );
      }).pipe(Effect.provide(configAt(home)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
