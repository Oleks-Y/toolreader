import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { LabelingFailed } from "../core/api.ts";
import { Labels, type LabelItem } from "../core/domain.ts";
import { ServerConfig } from "./ServerConfig.ts";

const TIMEOUT = Duration.minutes(3);
/** T3's defaults for text generation (packages/contracts/src/model.ts). */
const DEFAULT_MODEL = "gpt-5.6-luna";
const DEFAULT_EFFORT = "low";

const Store = Schema.Record(Schema.String, Labels);
type Store = typeof Store.Type;
const decodeStore = Schema.decodeUnknownOption(Schema.fromJsonString(Store));
const encodeStore = Schema.encodeEffect(Schema.fromJsonString(Store));

const T3Settings = Schema.Struct({
  textGenerationModelSelection: Schema.optional(
    Schema.Struct({
      instanceId: Schema.optional(Schema.String),
      model: Schema.optional(Schema.String),
      options: Schema.optional(Schema.Unknown),
    }),
  ),
});
const decodeSettings = Schema.decodeUnknownOption(Schema.fromJsonString(T3Settings));
// `options` is either `[{ id: "reasoningEffort", value }]` or `{ reasoningEffort }`, depending on T3's version.
const decodeEffortList = Schema.decodeUnknownOption(
  Schema.Array(Schema.Struct({ id: Schema.String, value: Schema.Unknown })),
);
const decodeEffortRecord = Schema.decodeUnknownOption(
  Schema.Struct({ reasoningEffort: Schema.String }),
);

const CodexOutput = Schema.Struct({
  labels: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
});
const decodeCodexOutput = Schema.decodeUnknownEffect(Schema.fromJsonString(CodexOutput));

const OUTPUT_JSON_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["labels"],
  properties: {
    labels: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label"],
        properties: { id: { type: "string" }, label: { type: "string" } },
      },
    },
  },
});

function prompt(context: string, items: ReadonlyArray<LabelItem>): string {
  return [
    "You label actions a coding agent took, for a human skimming what the agent DID.",
    "For each item write one short past-tense phrase (max 9 words) saying what the action did and, when obvious, why.",
    'Good: "Checked how thread messages are persisted". "Ran server typecheck; failed on decider.ts". "Pushed the fix branch".',
    "Name concrete files or subsystems. No filler like 'The agent'. Return every id exactly once.",
    "",
    `Context (user request): ${context.slice(0, 1500)}`,
    "",
    "Items (JSON):",
    JSON.stringify(items),
  ].join("\n");
}

/** Model + effort from T3's text-generation setting; non-Codex selections fall back to T3's Codex default. */
function modelSelection(settingsJson: string): { model: string; effort: string } {
  const sel = Option.getOrUndefined(decodeSettings(settingsJson))?.textGenerationModelSelection;
  const isCodex = !sel?.instanceId || sel.instanceId === "codex";
  const effort = Option.getOrUndefined(
    decodeEffortRecord(sel?.options).pipe(
      Option.map((o) => o.reasoningEffort),
      Option.orElse(() =>
        Option.flatMapNullishOr(
          decodeEffortList(sel?.options),
          (list) => list.find((x) => x.id === "reasoningEffort")?.value,
        ),
      ),
    ),
  );
  return {
    model: (isCodex && sel?.model) || DEFAULT_MODEL,
    effort: (isCodex && typeof effort === "string" && effort) || DEFAULT_EFFORT,
  };
}

export class Labeler extends Context.Service<
  Labeler,
  {
    readonly forThread: (threadId: string) => Effect.Effect<Labels>;
    /** Labels items with `codex exec` (read-only sandbox, ephemeral), caches and returns all labels for the thread. */
    readonly label: (
      threadId: string,
      context: string,
      items: ReadonlyArray<LabelItem>,
    ) => Effect.Effect<Labels, LabelingFailed>;
  }
>()("toolreader/server/Labeler") {
  static readonly layer = Layer.effect(
    Labeler,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const writes = yield* Semaphore.make(1);

      let store: Store = Option.getOrElse(
        decodeStore(
          yield* fs.readFileString(config.labelsPath).pipe(Effect.orElseSucceed(() => "{}")),
        ),
        () => ({}),
      );

      const forThread = (threadId: string) => Effect.sync(() => store[threadId] ?? {});

      const runCodex = Effect.fn("Labeler.runCodex")(function* (input: string) {
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "toolreader-" });
        const schemaPath = path.join(dir, "schema.json");
        const outPath = path.join(dir, "out.json");
        yield* fs.writeFileString(schemaPath, OUTPUT_JSON_SCHEMA);
        const settings = yield* fs
          .readFileString(path.join(path.dirname(config.dbPath), "settings.json"))
          .pipe(Effect.orElseSucceed(() => "{}"));
        const { model, effort } = modelSelection(settings);
        const handle = yield* spawner.spawn(
          ChildProcess.make(
            config.codexBin,
            [
              "exec",
              "--ephemeral",
              "--skip-git-repo-check",
              "-s",
              "read-only",
              "--model",
              model,
              "--config",
              `model_reasoning_effort="${effort}"`,
              "--output-schema",
              schemaPath,
              "--output-last-message",
              outPath,
              "-",
            ],
            { cwd: dir, stdin: { stream: Stream.encodeText(Stream.make(input)) } },
          ),
        );
        const [stderr, exitCode] = yield* Effect.all(
          [handle.stderr.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
          { concurrency: "unbounded" },
        );
        if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
          return yield* new LabelingFailed({
            message: `codex exec failed (${exitCode}): ${stderr.trim().split("\n").slice(-3).join(" ")}`,
          });
        }
        return yield* fs.readFileString(outPath).pipe(Effect.flatMap(decodeCodexOutput));
      }, Effect.scoped);

      const label = Effect.fn("Labeler.label")(function* (
        threadId: string,
        context: string,
        items: ReadonlyArray<LabelItem>,
      ) {
        const out = yield* runCodex(prompt(context, items)).pipe(
          Effect.timeoutOrElse({
            duration: TIMEOUT,
            orElse: () => Effect.fail(new LabelingFailed({ message: "codex exec timed out" })),
          }),
          Effect.catchTags({
            PlatformError: (e) => Effect.fail(new LabelingFailed({ message: e.message })),
            SchemaError: (e) =>
              Effect.fail(
                new LabelingFailed({ message: `codex returned unexpected output: ${e.message}` }),
              ),
          }),
        );
        return yield* writes.withPermits(1)(
          Effect.gen(function* () {
            const wanted = new Set(items.map((i) => i.id));
            const thread = { ...store[threadId] };
            for (const l of out.labels)
              if (wanted.has(l.id) && l.label.trim()) thread[l.id] = l.label.trim();
            store = { ...store, [threadId]: thread };
            const encoded = yield* encodeStore(store);
            yield* fs.makeDirectory(path.dirname(config.labelsPath), { recursive: true });
            yield* fs.writeFileString(config.labelsPath, encoded);
            return thread;
          }).pipe(
            Effect.mapError(
              (e) => new LabelingFailed({ message: `failed to save labels: ${e.message}` }),
            ),
          ),
        );
      });

      return Labeler.of({ forThread, label });
    }),
  );
}
