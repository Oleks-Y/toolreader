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
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { HistoryFailed } from "./HistoryClient.ts";

export const SKILL_NAME = "toolreader-history";

export const SKILL = `---
name: ${SKILL_NAME}
description: Use right after you make a git commit in this repository, and whenever you split, squash, rebase or reword commits that hold agent work, to declare which turns of which agent session produced each commit (toolreader history link). Also use when asked which session wrote a commit.
---

# Declare the agent history of your commits

This repository keeps, per commit, the agent turns that produced it. Your declaration is what
reviewers see first; matching by content only fills in commits nobody declared. A declaration is a
command you run in your session: it stores nothing, \`history sync\` reads it from your session's
history later. Run the commands from the repository. If \`toolreader\` isn't on PATH, use
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

You know where each part came from; matching may not. For each commit that comes out, link the
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
- Don't run \`history sync\` or push for this: the pre-push hook sends it.
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

/**
 * Commits the skill's files (or their removal), and nothing else; a no-op when the repo already
 * has them as they are.
 */
export const commitSkill = Effect.fn("historySkill.commit")(
  function* (repo: string, action: "install" | "uninstall") {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const git = (args: ReadonlyArray<string>) =>
      spawner.exitCode(ChildProcess.make("git", ["-C", repo, ...args]));
    const staged = yield* git(
      action === "install"
        ? ["add", "--", ...SKILL_PATHS]
        : ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...SKILL_PATHS],
    );
    if (staged !== ChildProcessSpawner.ExitCode(0))
      return yield* new HistoryFailed({ message: `staging the skill failed in ${repo}` });
    if (
      (yield* git(["diff", "--cached", "--quiet", "--", ...SKILL_PATHS])) ===
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
      ...SKILL_PATHS,
    ]);
    if (code !== ChildProcessSpawner.ExitCode(0))
      return yield* new HistoryFailed({ message: `git commit failed in ${repo} (exit ${code})` });
    return action === "install" ? "Committed the skill." : "Committed its removal.";
  },
  Effect.catchTag("PlatformError", (e) => Effect.fail(new HistoryFailed({ message: e.message }))),
);
