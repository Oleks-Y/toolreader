// The agent skill `history skill install` puts in a repo, so agents declare their own history
// (core/declare.ts): `.claude/skills/toolreader-history/SKILL.md` (Claude Code), linked from
// `.agents/skills/toolreader-history` (Codex), as this repo keeps its own skills. Unlike the hooks,
// it is meant to be committed (`--commit`): every agent that works in the repo then gets it. Like
// the hooks, it carries a hash of its text, so an upgrade replaces ours and an edited one is left
// alone.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { HistoryFailed } from "./HistoryClient.ts";

export const SKILL_NAME = "toolreader-history";

export const SKILL = `---
name: ${SKILL_NAME}
description: Use right after you make a git commit in this repository, and whenever you split, squash, rebase or reword commits that hold agent work, to declare which turns of which agent session produced each commit (toolreader history link). Also use when asked which session wrote a commit.
---

# Declare the agent history of your commits

This repository keeps, per commit, the agent turns that produced it. Your declaration (or the
commit's \`Agent-Session\` trailer) is the only link a commit gets: nothing fills in a commit
nobody declared. A declaration is a command you run in your session: it stores nothing,
\`history sync\` reads it from your session's history later. Run the commands from the repository. If \`toolreader\` isn't on PATH, use
\`npx toolreader\`.

## After each commit you make

\`\`\`bash
toolreader history link --sha HEAD --note "<what these turns did, in one sentence>"
\`\`\`

Without \`--turns\` it takes your turns since your previous declaration, through the current one.
When some of those were about something else, or the work started earlier, list your turns and name
the right ones:

\`\`\`bash
toolreader history turns                      # T1, T2, … with each turn's first prompt line
toolreader history link --sha HEAD --turns 3-5,9 --note "…"
\`\`\`

## When you split, squash, rebase or move work between commits

You know where each part came from; nothing else does. For each commit that comes out, link the
turns that wrote its content, in whichever session they ran:

\`\`\`bash
toolreader history turns --session <codex:… | claude-code:… | T3 thread id>
toolreader history link --sha <commit> --session <id> --turns 2-6 --note "…"
\`\`\`

Your own splitting turns didn't write that code: link them only to commits you changed by hand.
A rebase keeps declarations whose patch didn't change; after a squash or a split, declare again.

## When a link is wrong

\`\`\`bash
toolreader history unlink --sha <commit> [--session <id>]
\`\`\`

## Rules

- A command that fails declares nothing: read its error, fix it, run it again.
- The note is published with the history (redacted, but don't rely on that): no secrets, no names
  of clients or people.
- Don't run \`history sync\` or push for this: the hooks attempt delivery (when you stop, and on
  push). Neither a successful \`git push\` nor stopping confirms it; \`toolreader history status\`
  shows what's still pending.
`;

const SEAL = "<!-- toolreader skill sha256 ";
const sha256 = (s: string) => NodeCrypto.createHash("sha256").update(s).digest("hex");
/** A skill text with its hash appended, as `skillFiles` writes it. */
export const sealSkill = (text: string) => `${text}${SEAL}${sha256(text)} -->\n`;
const isSealed = (file: string) => {
  const at = file.lastIndexOf(`\n${SEAL}`) + 1;
  return at > 0 && file === sealSkill(file.slice(0, at));
};

/** Installs or removes the skill and its Codex link; an edited skill is left alone. */
export const skillFiles = Effect.fn("historySkill.files")(
  function* (repo: string, action: "install" | "uninstall") {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(repo, ".claude", "skills", SKILL_NAME);
    const file = path.join(dir, "SKILL.md");
    const link = path.join(repo, ".agents", "skills", SKILL_NAME);
    const target = path.join("..", "..", ".claude", "skills", SKILL_NAME);
    const current = (yield* fs.exists(file)) ? yield* fs.readFileString(file) : null;
    const ours = current !== null && isSealed(current);
    const linkOurs = yield* fs.readLink(link).pipe(
      Effect.map((to) => to === target),
      Effect.orElseSucceed(() => false),
    );
    if (action === "uninstall") {
      if (current !== null && !ours)
        return yield* new HistoryFailed({
          message: `${file} was edited since toolreader wrote it; leaving it alone.`,
        });
      if (current !== null) yield* fs.remove(dir, { recursive: true });
      if (linkOurs) yield* fs.remove(link);
      return current === null ? `No skill at ${file}.` : `Removed ${file}.`;
    }
    if (current !== null && !ours)
      return yield* new HistoryFailed({
        message: `${file} isn't the skill toolreader writes (edited, or someone else's); leaving it alone.`,
      });
    const sealed = sealSkill(SKILL);
    const fresh = current !== sealed;
    if (fresh) {
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.writeFileString(file, sealed);
    }
    if (!linkOurs && !(yield* fs.exists(link))) {
      yield* fs.makeDirectory(path.dirname(link), { recursive: true });
      yield* fs.symlink(target, link);
    }
    return fresh
      ? `${current === null ? "Installed" : "Updated"} the agent skill ${file}.`
      : `Already installed: ${file}.`;
  },
  Effect.catchTag("PlatformError", (e) => Effect.fail(new HistoryFailed({ message: e.message }))),
);

/**
 * The rule every session of an agent reads (AGENTS.md for Codex, CLAUDE.md for Claude Code): a
 * skill is only read when the agent thinks of it, this is always in context. A block of its own,
 * sealed by its hash, so an upgrade replaces ours and an edited one is left alone.
 */
export const RULE = `## Agent history

After each commit you make in this repository, declare which of your turns produced it:
\`toolreader history link --sha HEAD --note "<what these turns did>"\`. When you split, squash or
rebase commits, declare where each one came from. The \`${SKILL_NAME}\` skill has the details.
`;
const RULE_START = "<!-- toolreader-history sha256 ";
const RULE_END = "<!-- /toolreader-history -->";
const RULE_BLOCK =
  /<!-- toolreader-history sha256 ([0-9a-f]{64}) -->\n([\s\S]*?)<!-- \/toolreader-history -->\n?/;
const ruleBlock = (text: string) => `${RULE_START}${sha256(text)} -->\n${text}${RULE_END}\n`;

/** Adds, updates or removes the rule block in one instructions file. */
const ruleFile = Effect.fn("historySkill.rule")(function* (
  file: string,
  action: "install" | "uninstall",
) {
  const fs = yield* FileSystem.FileSystem;
  const current = (yield* fs.exists(file)) ? yield* fs.readFileString(file) : null;
  const found = current === null ? null : RULE_BLOCK.exec(current);
  const ours = found !== null && sha256(found[2]!) === found[1];
  if (found && !ours)
    return yield* new HistoryFailed({
      message: `${file}: its toolreader-history rule was edited; leaving it alone.`,
    });
  if (action === "uninstall") {
    if (!found || current === null) return `No rule in ${file}.`;
    const rest = current.replace(RULE_BLOCK, "").replace(/\n+$/, "\n");
    if (rest.trim() === "") yield* fs.remove(file);
    else yield* fs.writeFileString(file, rest);
    return `Removed the rule from ${file}.`;
  }
  const block = ruleBlock(RULE);
  if (found?.[0] === block) return `Already in ${file}.`;
  const next =
    current === null
      ? block
      : found
        ? current.replace(RULE_BLOCK, block)
        : `${current.replace(/\n*$/, "")}\n\n${block}`;
  yield* fs.writeFileString(file, next);
  return `${found ? "Updated" : "Added"} the rule in ${file}.`;
});

/** What Claude Code runs after each Bash command: a reminder when it was a `git commit`. */
export const REMIND_COMMAND =
  "command -v toolreader >/dev/null 2>&1 && toolreader history remind || true";
/**
 * What an agent runs when it (or a subagent) stops: the session's history sent in the
 * background, so work that made no commit and no push still reaches the backend.
 */
export const CAPTURE_COMMAND =
  "command -v toolreader >/dev/null 2>&1 && toolreader history capture || true";

/** Our hooks, by event: each recognized by the command it runs. */
const AGENT_HOOKS = [
  {
    event: "PostToolUse",
    matcher: "Bash",
    command: REMIND_COMMAND,
    marker: "toolreader history remind",
  },
  { event: "Stop", command: CAPTURE_COMMAND, marker: "toolreader history capture" },
  { event: "SubagentStop", command: CAPTURE_COMMAND, marker: "toolreader history capture" },
] as const;

const Settings = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown), { space: 2 });
const decodeSettings = Schema.decodeUnknownEffect(Settings);
const encodeSettings = Schema.encodeEffect(Settings);
type Entry = { matcher?: unknown; hooks?: Array<{ command?: unknown }> };
const isOurs = (marker: string) => (e: Entry) =>
  Array.isArray(e.hooks) &&
  e.hooks.length > 0 &&
  e.hooks.every((h) => typeof h.command === "string" && h.command.includes(marker));

/**
 * Adds or removes our hooks in a hooks file (the commit reminder after Bash, the capture on Stop
 * and SubagentStop), keeping everything else in it: Claude Code's `.claude/settings.json` and
 * Codex's `.codex/hooks.json` take the same shape, and the same events.
 */
const agentHooks = Effect.fn("historySkill.agentHooks")(function* (
  file: string,
  action: "install" | "uninstall",
  agent: "Claude Code" | "Codex",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const current = (yield* fs.exists(file)) ? yield* fs.readFileString(file) : null;
  const settings: Record<string, unknown> =
    current === null
      ? {}
      : {
          ...(yield* decodeSettings(current).pipe(
            Effect.mapError(
              () => new HistoryFailed({ message: `${file} isn't JSON; leaving it alone.` }),
            ),
          )),
        };
  const hooks = (
    settings.hooks && typeof settings.hooks === "object" ? { ...(settings.hooks as object) } : {}
  ) as Record<string, unknown>;
  let had = 0;
  let same = 0;
  for (const h of AGENT_HOOKS) {
    const entries = (Array.isArray(hooks[h.event]) ? hooks[h.event] : []) as Entry[];
    const ours = entries.find(isOurs(h.marker));
    const mine = {
      ...("matcher" in h ? { matcher: h.matcher } : {}),
      hooks: [{ type: "command", command: h.command }],
    };
    if (ours) had++;
    if (ours && ours.hooks?.length === 1 && ours.hooks[0]?.command === h.command) same++;
    const next = [
      ...entries.filter((e) => !isOurs(h.marker)(e)),
      ...(action === "install" ? [mine] : []),
    ];
    if (next.length > 0) hooks[h.event] = next;
    else delete hooks[h.event];
  }
  if (action === "install" && same === AGENT_HOOKS.length) return `Already in ${file}.`;
  if (action === "uninstall" && had === 0) return `No toolreader hooks in ${file}.`;
  if (Object.keys(hooks).length > 0) settings.hooks = hooks;
  else delete settings.hooks;
  if (Object.keys(settings).length === 0) {
    if (current !== null) yield* fs.remove(file);
  } else {
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, `${yield* encodeSettings(settings).pipe(Effect.orDie)}\n`);
  }
  return action === "install"
    ? `${had ? "Updated" : "Added"} the commit reminder and session capture hooks in ${file} (${agent}${agent === "Codex" ? ": approve them once with /hooks" : ""}).`
    : `Removed the commit reminder and session capture hooks from ${file}.`;
});

/**
 * Everything \`history skill install\` puts in a repo: the skill, the rule in AGENTS.md and
 * CLAUDE.md (once, when CLAUDE.md is a link to AGENTS.md), and the agent hooks for Claude Code
 * and Codex (the commit reminder, the capture on stop). Each part reports on its own; one left alone (edited) doesn't stop the others. Returns the lines to
 * print and the paths it changed, for \`--commit\`.
 */
export const installSkill = Effect.fn("historySkill.install")(function* (
  repo: string,
  action: "install" | "uninstall",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lines: string[] = [];
  const failed: string[] = [];
  const part = <R>(effect: Effect.Effect<string, { readonly message: string }, R>) =>
    effect.pipe(
      Effect.map((line) => lines.push(line)),
      Effect.catch((e) => Effect.sync(() => failed.push(e.message))),
    );
  yield* part(skillFiles(repo, action));
  const agents = path.join(repo, "AGENTS.md");
  const claude = path.join(repo, "CLAUDE.md");
  yield* part(ruleFile(agents, action));
  const sameFile =
    (yield* fs.realPath(claude).pipe(Effect.orElseSucceed(() => ""))) ===
    (yield* fs.realPath(agents).pipe(Effect.orElseSucceed(() => "-")));
  if (!sameFile) yield* part(ruleFile(claude, action));
  yield* part(agentHooks(path.join(repo, ".claude", "settings.json"), action, "Claude Code"));
  yield* part(agentHooks(path.join(repo, ".codex", "hooks.json"), action, "Codex"));
  return { lines, failed };
});

/** Every path \`installSkill\` may change, as \`git add\` takes them. */
export const INSTALLED_PATHS = [
  `.claude/skills/${SKILL_NAME}`,
  `.agents/skills/${SKILL_NAME}`,
  "AGENTS.md",
  "CLAUDE.md",
  ".claude/settings.json",
  ".codex/hooks.json",
] as const;

/** The skill's paths in a repo, as `git add` takes them. */
export const SKILL_PATHS = [
  `.claude/skills/${SKILL_NAME}`,
  `.agents/skills/${SKILL_NAME}`,
] as const;

/** Whether the repo has the skill (as committed by anyone, edited or not). */
export const hasSkill = (repo: string) =>
  Effect.flatMap(Path.Path, (path) =>
    Effect.flatMap(FileSystem.FileSystem, (fs) =>
      fs.exists(path.join(repo, SKILL_PATHS[0], "SKILL.md")),
    ),
  ).pipe(Effect.orElseSucceed(() => false));

/** Paths of `paths` with uncommitted changes of their own (modified, staged or untracked). */
export const dirtyPaths = Effect.fn("historySkill.dirty")(function* (
  repo: string,
  paths: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const out = yield* spawner
    .string(ChildProcess.make("git", ["-C", repo, "status", "--porcelain", "--", ...paths]))
    .pipe(Effect.orElseSucceed(() => ""));
  return paths.filter((p) =>
    out.split("\n").some((l) => l.slice(3).replace(/\/$/, "").startsWith(p)),
  );
});

/**
 * Commits `paths` (what the install changed, or removed), and nothing else; a no-op when the repo
 * already has them as they are.
 */
export const commitSkill = Effect.fn("historySkill.commit")(
  function* (repo: string, action: "install" | "uninstall", paths: ReadonlyArray<string>) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = (args: ReadonlyArray<string>) =>
      spawner.exitCode(ChildProcess.make("git", ["-C", repo, ...args]));
    // Only what exists or git knows: `git add` refuses a path that is neither.
    const known: string[] = [];
    for (const p of paths)
      if (
        (yield* fs.exists(path.join(repo, p))) ||
        (yield* git(["ls-files", "--error-unmatch", "--", p])) === ChildProcessSpawner.ExitCode(0)
      )
        known.push(p);
    if (known.length === 0) return "Nothing to commit.";
    if ((yield* git(["add", "-A", "--", ...known])) !== ChildProcessSpawner.ExitCode(0))
      return yield* new HistoryFailed({ message: `staging the skill failed in ${repo}` });
    if (
      (yield* git(["diff", "--cached", "--quiet", "--", ...known])) ===
      ChildProcessSpawner.ExitCode(0)
    )
      return action === "install" ? "The skill is committed as it is." : "Nothing to commit.";
    const code = yield* git([
      "commit",
      "-q",
      "-m",
      action === "install"
        ? "chore: agent history skill (toolreader)"
        : "chore: remove the agent history skill (toolreader)",
      "--",
      ...known,
    ]);
    if (code !== ChildProcessSpawner.ExitCode(0))
      return yield* new HistoryFailed({ message: `git commit failed in ${repo} (exit ${code})` });
    return action === "install" ? "Committed the skill." : "Committed its removal.";
  },
  Effect.catchTag("PlatformError", (e) => Effect.fail(new HistoryFailed({ message: e.message }))),
);
