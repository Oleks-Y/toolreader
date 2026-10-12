// Evaluates checkpoint collection on real sessions. Point it at a snapshot and a throwaway
// Postgres, never the live ones:
//   T3_DB=$PWD/.t3/statev2.sqlite TOOLREADER_DATABASE_URL=postgres://… \
//   TOOLREADER_TRACE=eval-trace.md node scripts/checkpointEval.ts [LIMIT]
// For the LIMIT most recent T3 threads with actions it takes a manual checkpoint twice and scores:
// determinism (a second take, plain or --replace, must store nothing), leaks the redactor missed (secret shapes and
// the home directory, checked by patterns of its own), what reached the record (models, usage)
// and how long each take ran. Exits non-zero on a leak or a non-repeat.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { findPrivate } from "../src/core/privacy.ts";
import { CheckpointApp } from "../src/server/app.ts";
import { Checkpoints } from "../src/server/checkpoints/Checkpoints.ts";
import { ServerConfig } from "../src/server/ServerConfig.ts";
import { ThreadStore } from "../src/server/ThreadStore.ts";
import { withTracing } from "../src/server/Trace.ts";

class EvalFailed extends Schema.TaggedErrorClass<EvalFailed>()("EvalFailed", {
  message: Schema.String,
}) {}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

// Independent of proof.ts on purpose: an oracle that shares the redactor's patterns finds nothing.
// Tuned on real sessions to no false positives: code (`token = req.cookies…`, `apiKey: process.env…`)
// and ids that merely contain `sk-` (`task-…`) don't count; a quoted literal with letters and digits does.
const SECRETS: ReadonlyArray<readonly [string, RegExp]> = [
  ["openai-key", /(?<![\w-])sk-(?:proj-)?[A-Za-z0-9_-]{20,}/],
  ["anthropic-key", /(?<![\w-])sk-ant-[A-Za-z0-9_-]{20,}/],
  ["github-token", /(?<!\w)(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ["aws-key", /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["jwt", /eyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}/],
  ["slack-token", /(?<!\w)xox[abpr]-[A-Za-z0-9-]{10,}/],
  [
    "assignment",
    /\b(?:password|passwd|secret|api[_-]?key|token)\s*[=:]\s*["'`](?=[^"'`]*\d)(?=[^"'`]*[A-Za-z])[A-Za-z0-9+/_-]{16,}["'`]/i,
  ],
];

const pct = (n: number, of: number) => (of === 0 ? "–" : `${Math.round((100 * n) / of)}%`);

const run = Effect.gen(function* () {
  const limit = Number(process.argv[2] ?? 20);
  const { home } = yield* ServerConfig;
  const checkpoints = yield* Checkpoints;
  const store = yield* ThreadStore;
  const threads = (yield* store.list)
    .filter((t) => (t.actionCount ?? 0) > 0)
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);

  const rows: Array<Record<string, string | number>> = [];
  const failures: string[] = [];
  const totals = { turns: 0, model: 0, usage: 0, privacy: 0 };
  for (const t of threads) {
    const take = (replace: boolean) =>
      checkpoints.take({
        session: t.id,
        trigger: "manual",
        repo: null,
        replace,
        outputs: true,
        maxOutput: 8192,
      });
    const [elapsed, first] = yield* Effect.timed(Effect.result(take(true)));
    const ms = Math.round(Duration.toMillis(elapsed));
    if (first._tag === "Failure") {
      rows.push({ thread: t.id.slice(0, 12), error: first.failure.message });
      failures.push(`${t.id}: take failed: ${first.failure.message}`);
      continue;
    }
    const cp = first.success.checkpoint;
    const again = yield* take(false);
    // A retake with --replace must also store nothing when only the moment it ran differs.
    const replaced = yield* take(true);
    const json = encodeJson(cp);
    const secrets = SECRETS.filter(([, re]) => re.test(json)).map(([name]) => name);
    const homeLeak = home.length > 1 && json.includes(home);
    // Paths, emails and hosts are expected in a private record; counted to size the sanitizer's job.
    const privacy = findPrivate(cp, {
      allowedPaths: [],
      allowedEmails: [],
      allowedHosts: [],
      forbidden: [],
    });
    const turns = cp.turns.length;
    totals.turns += turns;
    totals.model += cp.turns.filter((x) => x.model).length;
    totals.usage += cp.turns.filter((x) => x.usage).length;
    totals.privacy += privacy.length;
    if (again.result !== "exists") failures.push(`${t.id}: second take was ${again.result}`);
    if (replaced.result !== "exists")
      failures.push(`${t.id}: unchanged retake with --replace was ${replaced.result}`);
    if (secrets.length > 0) failures.push(`${t.id}: secret shapes ${secrets.join(", ")}`);
    if (homeLeak) failures.push(`${t.id}: home directory in the record`);
    rows.push({
      thread: t.id.slice(0, 12),
      provider: t.provider ?? "?",
      entries: cp.entries.length,
      turns,
      model: pct(cp.turns.filter((x) => x.model).length, turns),
      usage: pct(cp.turns.filter((x) => x.usage).length, turns),
      redactions: cp.redactions,
      privacy: privacy.length,
      repeat: again.result,
      replace: replaced.result,
      ms,
    });
  }
  console.table(rows);
  yield* Console.log(
    `${threads.length} threads · turns with model ${pct(totals.model, totals.turns)} · with usage ${pct(totals.usage, totals.turns)} · privacy findings ${totals.privacy}`,
  );
  if (rows.every((r) => "error" in r)) failures.push("no take succeeded: nothing was checked");
  if (failures.length > 0)
    return yield* new EvalFailed({
      message: `${failures.length} failure(s):\n  ${failures.join("\n  ")}`,
    });
  yield* Console.log("no leaks, every take repeatable");
});

run.pipe(
  Effect.provide(CheckpointApp()),
  withTracing("eval"),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
