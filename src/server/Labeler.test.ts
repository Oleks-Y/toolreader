import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { Labeler } from "./Labeler.ts";
import { ServerConfig } from "./ServerConfig.ts";

// Stands in for `codex exec`: labels every item from the prompt and writes --output-last-message.
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.FAKE_CODEX_FAIL) { process.stderr.write("boom: not logged in\\n"); process.exit(2); }
const out = args[args.indexOf("--output-last-message") + 1];
const items = JSON.parse(fs.readFileSync(0, "utf8").trim().split("\\n").at(-1));
fs.writeFileSync(out, JSON.stringify({ labels: [...items.map((i) => ({ id: i.id, label: " did " + i.id + " " })), { id: "extra", label: "ignored" }] }));
`;

const withLabeler = <A, E>(
  failing: boolean,
  use: (
    labeler: Labeler["Service"],
    labelsPath: string,
  ) => Effect.Effect<A, E, FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "toolreader-test-" });
    const codexBin = path.join(dir, failing ? "codex-fail.cjs" : "codex.cjs");
    yield* fs.writeFileString(
      codexBin,
      failing ? FAKE_CODEX.replace("process.env.FAKE_CODEX_FAIL", "true") : FAKE_CODEX,
    );
    yield* fs.chmod(codexBin, 0o755);
    const labelsPath = path.join(dir, "nested", "labels.json");
    const config = Layer.succeed(
      ServerConfig,
      ServerConfig.of({
        port: 0,
        home: dir,
        dbPath: path.join(dir, "state.sqlite"),
        codexBin,
        labelsPath,
        distDir: dir,
      }),
    );
    return yield* Effect.flatMap(Labeler, (labeler) => use(labeler, labelsPath)).pipe(
      Effect.provide(Labeler.layer.pipe(Layer.provide(config))),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("Labeler", () => {
  it.effect("labels items via codex exec, keeps only requested ids, and persists them", () =>
    withLabeler(false, (labeler, labelsPath) =>
      Effect.gen(function* () {
        const labels = yield* labeler.label("t1", "fix the build", [
          { id: "a1", text: "ran tests" },
          { id: "fold:a2", text: "explored" },
        ]);
        assert.deepStrictEqual(labels, { a1: "did a1", "fold:a2": "did fold:a2" });
        assert.deepStrictEqual(yield* labeler.forThread("t1"), labels);
        const fs = yield* FileSystem.FileSystem;
        assert.include(yield* fs.readFileString(labelsPath), '"fold:a2":"did fold:a2"');
      }),
    ),
  );

  it.effect("reports codex failures as LabelingFailed with stderr", () =>
    withLabeler(true, (labeler) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(labeler.label("t1", "ctx", [{ id: "a1", text: "x" }]));
        assert.strictEqual(error._tag, "LabelingFailed");
        assert.include(error.message, "boom: not logged in");
      }),
    ),
  );
});
