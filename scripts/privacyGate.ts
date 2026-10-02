// The publication gate for site/demo data: site/demo/make-data.sh runs it before writing
// ledger.json, and scripts/site.ts before embedding it. It checks the data against
// scripts/privacy.ts with this machine's own values, read at run time, and fails listing every
// offending string's path: `node scripts/privacyGate.ts FILE.json`.
import * as NodeOS from "node:os";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { findPrivate, type Finding, type PrivacyRules } from "./privacy.ts";

export class PrivacyGateFailed extends Schema.TaggedErrorClass<PrivacyGateFailed>()(
  "PrivacyGateFailed",
  { message: Schema.String },
) {}

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** Where local names come from: skills an agent may mention, and sibling projects. */
const NAME_DIRS = [".agents/skills", ".codex/skills", ".claude/skills", "proj"];

/**
 * Home, user, git identity, hostname, and the names of NAME_DIRS' entries. Names that are ordinary
 * English words (the system word list) are left out: a project called `empty` must not fail
 * "chore: empty repo". Without a word list, every name is checked.
 */
const machineValues = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const home = yield* Config.string("HOME").pipe(Config.withDefault(""));
  const user = yield* Config.string("USER").pipe(Config.withDefault(""));
  const gitConfig = (key: string) =>
    spawner.string(ChildProcess.make("git", ["config", key])).pipe(
      Effect.map((s) => s.trim()),
      Effect.orElseSucceed(() => ""),
    );
  const host = NodeOS.hostname();
  const words = yield* fs.readFileString("/usr/share/dict/words").pipe(
    Effect.map((text) => new Set(text.toLowerCase().split("\n"))),
    Effect.orElseSucceed(() => new Set<string>()),
  );
  const names: Array<string> = [];
  for (const dir of NAME_DIRS)
    for (const name of yield* fs
      .readDirectory(path.join(home, dir))
      .pipe(Effect.orElseSucceed(() => [])))
      if (name.length >= 3 && !words.has(name.toLowerCase())) names.push(name);
  const identities = [home, user, yield* gitConfig("user.email"), yield* gitConfig("user.name")];
  identities.push(host, host.split(".")[0] ?? "");
  return [...new Set([...identities.filter((v) => v.length >= 2), ...names])];
});

export const demoRules = (forbidden: ReadonlyArray<string>): PrivacyRules => ({
  allowedPaths: ["/work/wordfreq", "/bin/zsh", "/bin/bash", "/bin/sh", "/usr/bin/env", "/dev/null"],
  allowedEmails: ["demo@example.com", "agent@example.com"],
  allowedHosts: ["example.com", "example.org"],
  forbidden,
});

const fail = (label: string, findings: ReadonlyArray<Finding>) =>
  new PrivacyGateFailed({
    message: `${label}: ${findings.length} private string(s), not published:\n${findings
      .map((f) => `  ${f.path}  ${f.reason}  ${JSON.stringify(f.match)}`)
      .join("\n")}`,
  });

/** Fails unless `value` (parsed demo data) passes every rule. */
export const privacyGate = Effect.fn("privacyGate")(function* (label: string, value: unknown) {
  const findings = findPrivate(value, demoRules(yield* machineValues));
  if (findings.length > 0) return yield* fail(label, findings);
});

if (import.meta.main)
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = process.argv[2];
    if (!file) return yield* new PrivacyGateFailed({ message: "usage: privacyGate.ts FILE.json" });
    yield* privacyGate(file, yield* decodeJson(yield* fs.readFileString(file)));
    yield* Effect.log(`privacy gate: ${file} is clean`);
  }).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
