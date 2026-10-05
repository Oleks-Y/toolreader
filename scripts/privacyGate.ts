// The publication gate for site/demo data: site/demo/make-data.sh runs it before writing
// ledger.json, and scripts/site.ts before embedding it. It checks the data against
// src/core/privacy.ts with this machine's own values, read at run time, and fails listing every
// offending string's path: `node scripts/privacyGate.ts FILE.json`.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { findPrivate, type Finding, type PrivacyRules } from "../src/core/privacy.ts";
import { machineValues as localValues } from "../src/server/Sanitizer.ts";

export class PrivacyGateFailed extends Schema.TaggedErrorClass<PrivacyGateFailed>()(
  "PrivacyGateFailed",
  { message: Schema.String },
) {}

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** Where local names come from: skills an agent may mention, and sibling projects. */
const NAME_DIRS = [".agents/skills", ".codex/skills", ".claude/skills", "proj"];

/** This machine's values (Sanitizer.machineValues) with NAME_DIRS under home. */
const machineValues = Effect.gen(function* () {
  const path = yield* Path.Path;
  const home = yield* Config.string("HOME").pipe(Config.withDefault(""));
  const { identities, names } = yield* localValues(
    home,
    NAME_DIRS.map((d) => path.join(home, d)),
  );
  return [...identities, ...names];
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
