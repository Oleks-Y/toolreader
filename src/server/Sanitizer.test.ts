import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { Action } from "../core/domain.ts";
import { LEDGER_FORMAT_VERSION, type LedgerEntry } from "../core/ledger.ts";
import { batches, jsonObjects, Sanitizer } from "./Sanitizer.ts";
import { ServerConfig } from "./ServerConfig.ts";

// Stands in for `codex-acp`: speaks ACP over stdio, asks for a permission once, logs what it was
// told, and names "Clover Casino" when the prompt has it (or replies garbage when FAKE_ACP_GARBAGE).
const FAKE_ACP = `#!/usr/bin/env node
const fs = require("node:fs");
const log = (x) => fs.appendFileSync(process.env.FAKE_ACP_LOG, JSON.stringify(x) + "\\n");
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
let buf = "", pending = null;
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    log({ jsonrpc: m.jsonrpc, method: m.method, params: m.params, result: m.result, mode: process.env.INITIAL_AGENT_MODE });
    if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: 1 } });
    else if (m.method === "session/new") send({ id: m.id, result: { sessionId: "s1" } });
    else if (m.method === "session/set_config_option") send({ id: m.id, result: { configOptions: [] } });
    else if (m.method === "session/prompt") {
      if (process.env.FAKE_ACP_HANG) continue;
      pending = m;
      send({ id: "perm", method: "session/request_permission", params: { sessionId: "s1" } });
    } else if (m.id === "perm") {
      const text = pending.params.prompt[0].text;
      const reply = process.env.FAKE_ACP_GARBAGE
        ? "no json here"
        : "Warning: model metadata\\n" + JSON.stringify({ findings: [
            ...(text.includes("Clover Casino") ? [{ text: "Clover Casino", kind: "Organization" }] : []),
            ...(text.includes("Widget Works") ? [{ text: "Widget Works", kind: "project" }] : []),
            { text: "4783", kind: "other" }, { text: "http://127.0.0.1:4783/x", kind: "url" },
            { text: "<path> and more", kind: "other" }, { text: "invoices for Clover Casino", kind: "project" },
            { text: "~/.codex/sessions/2026", kind: "path" }, { text: "@acme", kind: "organization" },
            { text: "localhost:4777", kind: "url" },
            { text: "README.md", kind: "path" },
            { text: "https://github.com/acme/app/pull/1", kind: "url" }, { text: "bot@users.noreply.github.com", kind: "email" },
            { text: "not in the text at all", kind: "other" },
            { text: "app", kind: "project" },
          ] });
      // Answers twice, as an agent sometimes does; braces inside strings must not confuse the reader.
      for (const part of [reply.slice(0, 10), reply.slice(10), process.env.FAKE_ACP_GARBAGE ? "" : ' {"note":"}{"}'])
        send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: part } } } });
      send({ id: pending.id, result: { stopReason: "end_turn" } });
    }
  }
});
`;

/** One message the fake agent received. */
const Logged = Schema.Struct({
  jsonrpc: Schema.optional(Schema.String),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
  mode: Schema.optional(Schema.String),
});
const decodeLogged = Schema.decodeUnknownSync(Schema.fromJsonString(Logged));
const decodePrompt = Schema.decodeUnknownSync(
  Schema.Struct({ prompt: Schema.Tuple([Schema.Struct({ text: Schema.String })]) }),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const entry = (actions: Action[]): LedgerEntry => ({
  formatVersion: LEDGER_FORMAT_VERSION,
  commit: { sha: "abc", subject: "feat: invoices", committedAt: "t", patchId: null },
  thread: {
    id: "t1",
    title: "invoices for Clover Casino",
    source: "codex",
    provider: null,
    origin: null,
  },
  match: "sha",
  outputs: "included",
  redactions: 0,
  entries: actions,
  labels: {},
});

const run = (id: string, command: string, output?: string): Action => ({
  type: "action",
  id,
  at: "t",
  kind: "run",
  status: "ok",
  title: command,
  command,
  ...(output ? { output } : {}),
});

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (s) =>
    s.string(ChildProcess.make("git", [...args], { cwd })),
  );

const withSanitizer = <A, E>(
  config: object,
  env: Record<string, string>,
  use: (
    sanitizer: Sanitizer["Service"],
    repo: string,
    logFile: string,
  ) => Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Path.Path
  >,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "toolreader-test-" }),
    );
    const repo = path.join(dir, "app");
    yield* fs.makeDirectory(repo);
    yield* git(repo, ["init", "-q"]);
    yield* git(repo, ["remote", "add", "origin", "https://github.com/acme/app.git"]);
    // The project's own README names Widget Works: an agent naming it is overruled.
    yield* fs.writeFileString(
      path.join(repo, "README.md"),
      "Built with Widget Works, like quaxly.\n",
    );
    // Sibling projects: one the project names itself, one it doesn't.
    for (const sibling of ["quaxly", "zorbix"]) yield* fs.makeDirectory(path.join(dir, sibling));
    yield* git(repo, ["add", "README.md"]);
    yield* git(repo, [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "commit",
      "-q",
      "-m",
      "init",
    ]);
    const agent = path.join(dir, "fake-acp.cjs");
    yield* fs.writeFileString(agent, FAKE_ACP);
    yield* fs.chmod(agent, 0o755);
    const logFile = path.join(dir, "acp.log");
    // This machine's own settings: the private names, never in the repo.
    const machineConfig = path.join(dir, "machine.json");
    yield* fs.writeFileString(
      machineConfig,
      encodeJson({
        sanitize: { private: ["zebra-corp"], agent: { instructions: "Zebra is a client." } },
      }),
    );
    yield* fs.writeFileString(
      path.join(repo, ".toolreader.json"),
      encodeJson(config).replace("FAKE_AGENT", agent),
    );
    const serverConfig = Layer.succeed(
      ServerConfig,
      ServerConfig.of({
        port: 0,
        home: "/home/test",
        dbPath: "",
        codexBin: "/opt/codex/bin/codex",
        codexHome: "",
        labelsPath: "",
        userConfigPath: machineConfig,
        distDir: "",
      }),
    );
    // The agent inherits this process's environment.
    const added = { FAKE_ACP_LOG: logFile, ...env };
    Object.assign(process.env, added);
    return yield* Effect.flatMap(Sanitizer, (s) => use(s, repo, logFile)).pipe(
      Effect.provide(Sanitizer.layer.pipe(Layer.provide(serverConfig))),
      Effect.ensuring(
        Effect.sync(() => {
          for (const key of Object.keys(added)) delete process.env[key];
        }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const agentConfig = {
  sanitize: {
    allow: ["~/.codex/"],
    agent: {
      enabled: true,
      command: "FAKE_AGENT",
      model: "gpt-test",
      effort: "low",
      instructions: "The client is private.",
    },
  },
};

describe("Sanitizer", () => {
  it.live("hides what the rules and the ACP agent name, and the agent may not act", () =>
    withSanitizer(agentConfig, {}, (sanitizer, repo, logFile) =>
      Effect.gen(function* () {
        const input = entry([
          run(
            "a1",
            "cat /home/test/notes/zebra-corp.md ~/.codex/config.toml",
            "deploy for Clover Casino with Widget Works on http://127.0.0.1:4783/x, localhost:4777, @acme, ~/.codex/sessions/2026, README.md, https://github.com/acme/app/pull/1, bot@users.noreply.github.com",
          ),
          run("a2", `cd ${repo} && ls src/app`),
        ]);
        const out = yield* sanitizer.sanitize(repo, [input], { mode: null, agent: null });
        assert.strictEqual(out.mode, "anonymize");
        assert.deepStrictEqual(out.spans, [{ text: "Clover Casino", kind: "organization" }]);
        const [a1, a2] = out.entries[0]!.entries as Action[];
        assert.strictEqual(a1!.command, "cat <path> ~/.codex/config.toml");
        assert.strictEqual(
          a1!.output,
          "deploy for <organization> with Widget Works on http://127.0.0.1:4783/x, localhost:4777, @acme, ~/.codex/sessions/2026, README.md, https://github.com/acme/app/pull/1, bot@users.noreply.github.com",
        );
        assert.strictEqual(a2!.command, "cd . && ls src/app", "the project's own name stays");
        assert.strictEqual(out.entries[0]!.thread.title, "invoices for <organization>");

        const fs = yield* FileSystem.FileSystem;
        const log = (yield* fs.readFileString(logFile))
          .trim()
          .split("\n")
          .map((l) => decodeLogged(l));
        assert.isTrue(log.every((m) => m.jsonrpc === "2.0" && m.mode === "read-only"));
        assert.deepStrictEqual(
          log.filter((m) => m.method === "session/set_config_option").map((m) => m.params),
          [
            { sessionId: "s1", configId: "model", value: "gpt-test" },
            { sessionId: "s1", configId: "reasoning_effort", value: "low" },
          ],
        );
        assert.deepStrictEqual(log.find((m) => !m.method && m.result)?.result, {
          outcome: { outcome: "cancelled" },
        });
        const prompt = decodePrompt(log.find((m) => m.method === "session/prompt")?.params)
          .prompt[0].text;
        assert.include(prompt, "acme/app");
        assert.include(prompt, "Zebra is a client.\nThe client is private.");
        const path = yield* Path.Path;
        const review = yield* git(repo, ["rev-parse", "--git-path", "toolreader-sanitize.json"]);
        assert.include(
          yield* fs.readFileString(path.resolve(repo, review.trim())),
          '"text":"Clover Casino"',
        );
        assert.notInclude(prompt, "zebra-corp", "the agent reads what the rules leave");
      }),
    ),
  );

  it.live("retries, then fails rather than publish, when the agent's reply makes no sense", () =>
    withSanitizer(agentConfig, { FAKE_ACP_GARBAGE: "1" }, (sanitizer, repo, logFile) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          sanitizer.sanitize(repo, [entry([run("a1", "ls")])], { mode: "remove", agent: null }),
        );
        assert.strictEqual(error._tag, "SanitizeFailed");
        assert.include(error.message, "no json here");
        const fs = yield* FileSystem.FileSystem;
        const prompts = (yield* fs.readFileString(logFile)).match(/"session\/prompt"/g) ?? [];
        assert.strictEqual(prompts.length, 3, "tried twice more first");
      }),
    ),
  );

  it.live("without the agent, the CLI's choice overrides the config", () =>
    withSanitizer(agentConfig, {}, (sanitizer, repo) =>
      Effect.gen(function* () {
        const input = entry([run("a1", "cat /home/test/zebra-corp.md", "ok")]);
        const off = yield* sanitizer.sanitize(repo, [input], { mode: "off", agent: null });
        assert.strictEqual(off.entries[0], input);
        const named = yield* sanitizer.sanitize(
          repo,
          [entry([run("a1", "diff ../quaxly ../zorbix")])],
          { mode: "anonymize", agent: false },
        );
        assert.strictEqual(
          (named.entries[0]!.entries[0] as Action).command,
          "diff ../quaxly ../<private>",
          "a sibling the project names stays",
        );
        const removed = yield* sanitizer.sanitize(repo, [input], { mode: "remove", agent: false });
        assert.deepStrictEqual([removed.entries[0]!.entries.length, removed.spans], [0, null]);
      }),
    ),
  );

  it.live("gives up on an agent that never answers, after retrying", () =>
    withSanitizer(
      { sanitize: { agent: { ...agentConfig.sanitize.agent, timeoutSeconds: 1.5 } } },
      { FAKE_ACP_HANG: "1" },
      (sanitizer, repo, logFile) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            sanitizer.sanitize(repo, [entry([run("a1", "ls")])], { mode: null, agent: null }),
          );
          assert.include(error.message, "did not answer in time");
          const fs = yield* FileSystem.FileSystem;
          // Each attempt is a fresh agent; it may time out before it even reads the prompt.
          const starts = (yield* fs.readFileString(logFile)).match(/"initialize"/g) ?? [];
          assert.strictEqual(starts.length, 3);
        }),
    ),
  );

  it("jsonObjects finds each top-level object, braces in strings included", () => {
    assert.deepStrictEqual(jsonObjects('Warning: x {y}\n{"a":"}{"} {"b":{"c":1}} trailing {'), [
      "{y}",
      '{"a":"}{"}',
      '{"b":{"c":1}}',
    ]);
  });

  it("batches split long texts and keep each prompt near the size", () => {
    assert.deepStrictEqual(batches(["aaaa", "bb", "cccccccccc"], 5), [
      ["aaaa"],
      ["bb"],
      ["ccccc"],
      ["ccccc"],
    ]);
    assert.deepStrictEqual(batches(["a", "b", "c"], 5), [["a", "b", "c"]]);
  });
});
