// Offline evaluation of per-hunk blame (core/blame.ts) on real commits: for each hunk, which
// pieces of the threads already linked to its commit (`history sync --dry-run`'s links) Jev says
// produced it. It SENDS REDACTED SESSION TEXT AND THE COMMIT'S DIFF TO TYPESAFE unless --dry-run:
//   node scripts/blameEval.ts --repo ~/proj/app --range main~5..main [--source auto]
//     [--file src/x.ts [--line 42]] [--full] [--max-hunks 40] (--dry-run [--show-request] | --i-understand-this-sends-session-text)
// --file/--line blame only the hunks of that file (holding that line, numbered as the commit has
// the file); --full lists every piece's whole command. With TYPESAFE_API_KEY set, or the key in
// ~/.toolreader/typesafe.key. Point T3_DB at a snapshot (CLAUDE.md, Test data). Each hunk prints
// the pieces Jev blamed, so the answers can be labeled by hand.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildRequest,
  covers,
  hunksOf,
  piecesOf,
  readBlame,
  SystemOneResponse,
  type HunkBlame,
  type Piece,
} from "../src/core/blame.ts";
import { redactor } from "../src/core/proof.ts";
import { textSanitizer } from "../src/core/sanitize.ts";
import { CliApp } from "../src/server/app.ts";
import { HistorySync } from "../src/server/history/HistorySync.ts";
import { RepoSessions, SESSION_SOURCES, type SessionSource } from "../src/server/RepoSessions.ts";
import { machineValues } from "../src/server/Sanitizer.ts";
import { ServerConfig } from "../src/server/ServerConfig.ts";

class EvalFailed extends Schema.TaggedErrorClass<EvalFailed>()("EvalFailed", {
  message: Schema.String,
}) {}

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
/** jev-1.13 price per input token (docs.typesafe.ai/models: $0.042 per million; output is free). */
const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeResponse = HttpClientResponse.schemaBodyJson(SystemOneResponse);

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const run = Effect.gen(function* () {
  const repoArg = option("--repo") ?? process.cwd();
  const range = option("--range") ?? (option("--sha") ? `-1 ${option("--sha")}` : undefined);
  const source = (option("--source") ?? "auto") as SessionSource;
  const maxHunks = Number(option("--max-hunks") ?? 40);
  const file = option("--file");
  const line = option("--line") === undefined ? null : Number(option("--line"));
  if (line !== null && (!file || !Number.isInteger(line)))
    return yield* new EvalFailed({ message: "--line N needs --file PATH (repo-relative)" });
  const dryRun = flag("--dry-run");
  if (!range) return yield* new EvalFailed({ message: "--range A..B or --sha X is required" });
  if (!SESSION_SOURCES.includes(source))
    return yield* new EvalFailed({ message: `--source is one of ${SESSION_SOURCES.join(", ")}` });
  // The environment's key, else the file (mode 600) a developer put it in.
  const keyFile = `${(yield* ServerConfig).home}/.toolreader/typesafe.key`;
  const fromFile = yield* (yield* FileSystem.FileSystem).readFileString(keyFile).pipe(
    Effect.map((k) => k.trim()),
    Effect.orElseSucceed(() => ""),
  );
  const apiKey = Option.orElse(yield* Config.option(Config.redacted("TYPESAFE_API_KEY")), () =>
    fromFile ? Option.some(Redacted.make(fromFile)) : Option.none(),
  );
  if (!dryRun) {
    if (Option.isNone(apiKey))
      return yield* new EvalFailed({ message: `set TYPESAFE_API_KEY or write it to ${keyFile}` });
    if (!flag("--i-understand-this-sends-session-text"))
      return yield* new EvalFailed({
        message:
          "this sends redacted session text and the commits' diffs to api.typesafe.ai; pass --i-understand-this-sends-session-text, or --dry-run",
      });
  }

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const git = (...a: string[]) =>
    spawner.string(ChildProcess.make("git", ["-C", repoArg, "-c", "core.quotePath=false", ...a]));
  const repo = (yield* git("rev-parse", "--show-toplevel")).trim();

  // The links `history sync` would send, then the sessions whole for their pieces.
  // ponytail: loads the sessions twice (sync, then here); fine for an eval.
  const report = yield* Effect.flatMap(HistorySync, (h) =>
    h.sync(repo, range, { source, dryRun: true }),
  );
  const loaded = yield* Effect.flatMap(RepoSessions, (r) => r.load(repo, source));
  const byId = new Map(loaded.sessions.map((s) => [s.thread.id, s.entries]));
  // Worktree roots go first, so paths come out repo-relative; then secrets, and home as `~`.
  const roots = loaded.roots.toSorted((a, b) => b.length - a.length);
  // Then this machine's identities (email, user, host, git name) and emails, as the sanitizer
  // anonymizes a published ledger.
  const { home } = yield* ServerConfig;
  const { clean: redact, count } = redactor(home);
  const local = yield* machineValues(home, [], repo);
  const anonymize = textSanitizer({
    repo,
    home,
    allow: [],
    names: local.identities.filter((n) => n !== home),
    spans: [],
  });
  let anonymized = 0;
  const clean = (s: string) => {
    const r = anonymize(redact(roots.reduce((t, root) => t.split(`${root}/`).join(""), s)));
    anonymized += r.hits;
    return r.text;
  };

  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
    HttpClient.retryTransient({ schedule: Schedule.exponential("250 millis"), times: 2 }),
  );
  const ask = (body: unknown) =>
    HttpClientRequest.post(ENDPOINT).pipe(
      HttpClientRequest.bearerToken(Option.getOrThrow(apiKey)),
      HttpClientRequest.acceptJson,
      HttpClientRequest.bodyJsonUnsafe(body),
      client.execute,
      Effect.flatMap(decodeResponse),
      Effect.timeout(Duration.seconds(30)),
      Effect.map((response) => ({ response, error: null })),
      Effect.catch((e) => Effect.succeed({ response: null, error: String(e.message ?? e) })),
    );

  yield* Console.log(
    `${report.commits.length} commits, ${loaded.sessions.length} sessions${dryRun ? ", dry run: nothing sent" : ""}\n`,
  );
  const tally = { hunks: 0, attributed: 0, possibly: 0, none: 0, unavailable: 0, tokens: 0 };
  const latencies: number[] = [];
  for (const { record } of report.commits) {
    yield* Console.log(`${record.sha.slice(0, 8)} ${record.subject.slice(0, 70)}`);
    if (record.links.length === 0) {
      yield* Console.log("  no linked threads\n");
      continue;
    }
    const pieces = piecesOf(record.links, (id) => byId.get(id), record.committedAt);
    const hunks = hunksOf(
      yield* git("diff-tree", "-p", "-U3", "--no-color", "--no-ext-diff", "--root", record.sha),
    ).filter((h) => !file || (line === null ? h.path === file : covers(h, file, line)));
    yield* Console.log(
      `  ${record.links.length} linked threads, ${pieces.length} pieces, ${hunks.length} hunks`,
    );
    for (const p of pieces)
      yield* Console.log(`    ${p.id} ${describePiece(p, clean, flag("--full"))}`);

    for (const hunk of hunks) {
      if (tally.hunks >= maxHunks) break;
      tally.hunks++;
      const request = buildRequest({ subject: record.subject, hunk, pieces }, clean);
      const where = `  ${hunk.id} ${hunk.path} ${hunk.header.split("@@")[1]?.trim() ?? ""}`;
      const size = `state ${request.stateBytes} B, ${request.asked.length} pieces${request.dropped ? ` (${request.dropped} dropped)` : ""}`;
      if (dryRun) {
        yield* Console.log(`${where}  ${size}`);
        if (flag("--show-request")) yield* Console.log(encodeJson(request.body));
        continue;
      }
      const [elapsed, { response, error }] = yield* Effect.timed(ask(request.body));
      latencies.push(Duration.toMillis(elapsed));
      const blame: HunkBlame = response
        ? readBlame(request, response)
        : { status: "unavailable", reason: error ?? "no response" };
      tally[blame.status]++;
      if (blame.status !== "unavailable") tally.tokens += blame.inputTokens;
      yield* Console.log(`${where}  → ${describeBlame(blame)}`);
      // The blamed pieces whole, to check the answer against.
      if (blame.status !== "unavailable")
        for (const { id } of [...blame.by, ...blame.possibly]) {
          const p = pieces.find((x) => x.id === id);
          if (p) yield* Console.log(`\n    ${id} ${describePiece(p, clean, true)}\n`);
        }
    }
    yield* Console.log("");
  }
  yield* Console.log(
    `${count()} redactions, ${anonymized} anonymized in what was ${dryRun ? "built" : "sent"}`,
  );
  if (dryRun) return;
  const sorted = latencies.toSorted((a, b) => a - b);
  yield* Console.log(
    [
      `${tally.hunks} hunks: ${tally.attributed} attributed, ${tally.possibly} possibly, ${tally.none} none, ${tally.unavailable} unavailable`,
      `median ${Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0)} ms, p95 ${Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0)} ms`,
      `${tally.tokens} input tokens ≈ $${(tally.tokens * USD_PER_INPUT_TOKEN).toFixed(4)}`,
    ].join("\n"),
  );
});

/** One line, or with `full` the whole command (an edit's title and diffs), indented. */
const describePiece = (p: Piece, clean: (s: string) => string, full = false) => {
  const a = p.action;
  if (!full)
    return `${a.kind.padEnd(6)} ${clean(a.command ?? a.title)
      .replace(/\s+/g, " ")
      .slice(0, 90)}`;
  const diffs = (a.files ?? []).flatMap((f) => (f.diff ? [`--- ${f.path}`, f.diff] : []));
  const body = a.command ? [a.command] : [a.title, ...diffs];
  return `${a.kind}\n${clean(body.join("\n"))
    .split("\n")
    .map((l) => `        ${l}`)
    .join("\n")}`;
};

const describeBlame = (b: HunkBlame) =>
  b.status === "unavailable"
    ? `unavailable: ${b.reason}`
    : [
        b.status,
        b.by.length ? `by ${b.by.map((x) => `${x.id} ${x.p.toFixed(2)}`).join(", ")}` : "",
        b.possibly.length
          ? `possibly ${b.possibly.map((x) => `${x.id} ${x.p.toFixed(2)}`).join(", ")}`
          : "",
        b.touched.length
          ? `not writers: ${b.touched.map((x) => `${x.id} ${x.role} ${x.p.toFixed(2)}`).join(", ")}`
          : "",
        `main ${b.main.id} ${b.main.p.toFixed(2)} (conf ${b.main.confidence.toFixed(2)})`,
      ]
        .filter(Boolean)
        .join(" · ");

run.pipe(
  Effect.catchTag("EvalFailed", (e) =>
    Console.error(`blameEval: ${e.message}`).pipe(
      Effect.andThen(Effect.sync(() => (process.exitCode = 1))),
    ),
  ),
  Effect.provide(
    Layer.merge(
      FetchHttpClient.layer,
      CliApp({ appServer: option("--source") === "codex-app-server", codexHome: null }),
    ),
  ),
  NodeRuntime.runMain,
);
