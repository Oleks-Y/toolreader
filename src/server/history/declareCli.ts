// `toolreader history turns|link|unlink`: what an agent runs, from inside its session, to say which
// of its turns produced a commit (core/declare.ts). `link` and `unlink` store nothing: the command
// and what it prints stay in the session's history, where `history sync` reads them. They check
// what they are told and fail when it's wrong, so a failed declaration is never applied.
//   toolreader history turns [--session ID]
//   toolreader history link --sha REV [--turns 3-5,9] [--session ID] [--note TEXT]
//   toolreader history unlink --sha REV [--session ID]
// The session is the one the agent runs in (CODEX_THREAD_ID, CLAUDE_CODE_SESSION_ID) unless
// `--session` names another.
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { declaredLine, declarationsIn, isGitCommit, parseTurns } from "../../core/declare.ts";
import { redactText } from "../../core/proof.ts";
import { splitTurns } from "../../core/tree.ts";
import { CliApp } from "../app.ts";
import { RepoSessions, type RepoSession } from "../RepoSessions.ts";
import { HistoryFailed } from "./HistoryClient.ts";

const repoFlag = Flag.string("repo").pipe(
  Flag.withDescription("Repository (any path inside it)"),
  Flag.withDefault("."),
);
const sessionFlag = Flag.string("session").pipe(
  Flag.withDescription(
    "Another session (codex:<id>, claude-code:<id> or a T3 thread id); default: the one this runs in",
  ),
  Flag.optional,
);

/** The session this command runs in, by what the agent exports, if any. */
const ownSession = Effect.gen(function* () {
  const env = (name: string) =>
    Config.option(Config.string(name)).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
  const codex = yield* env("CODEX_THREAD_ID");
  if (codex) return `codex:${codex}`;
  const claude = yield* env("CLAUDE_CODE_SESSION_ID");
  return claude ? `claude-code:${claude}` : null;
});

/** The session named (or this one), as `history sync` will find it. */
const session = Effect.fn("declare.session")(function* (
  repo: string,
  named: Option.Option<string>,
) {
  const name = Option.getOrNull(named) ?? (yield* ownSession);
  if (!name)
    return yield* new HistoryFailed({
      message:
        "Not inside an agent session (no CODEX_THREAD_ID or CLAUDE_CODE_SESSION_ID): name one with --session",
    });
  const loaded = yield* Effect.flatMap(RepoSessions, (r) => r.load(repo, "auto")).pipe(
    Effect.mapError((e) => new HistoryFailed({ message: e.message })),
  );
  const found = loaded.named(name)[0];
  return { name, found: found ?? null, own: Option.isNone(named) };
});

/** The full SHA of a commit. */
const commitSha = Effect.fn("declare.commitSha")(function* (repo: string, rev: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const sha = yield* spawner
    .string(
      ChildProcess.make("git", ["-C", repo, "rev-parse", "--verify", "-q", `${rev}^{commit}`]),
    )
    .pipe(Effect.orElseSucceed(() => ""));
  if (!sha.trim()) return yield* new HistoryFailed({ message: `No commit ${rev} in ${repo}` });
  return sha.trim();
});

const title = (s: RepoSession) => redactText(s.thread.title).text;
const firstLine = (text: string) => redactText(text.split("\n")[0] ?? "").text.slice(0, 100);

/** `3-5,9` from turn numbers, for what the commands print. */
const ranges = (turns: ReadonlyArray<number>) => {
  const out: string[] = [];
  for (const n of turns) {
    const last = out.at(-1);
    const m = last ? /^(\d+)(?:-(\d+))?$/.exec(last) : null;
    if (m && Number(m[2] ?? m[1]) === n - 1) out[out.length - 1] = `${m[1]}-${n}`;
    else out.push(String(n));
  }
  return out.map((r) => `T${r.replace("-", "–T")}`).join(", ");
};

const turns = Command.make(
  "turns",
  { repo: repoFlag, session: sessionFlag },
  Effect.fn("toolreader history turns")(function* (flags) {
    const repo = (yield* Path.Path).resolve(flags.repo);
    const { name, found } = yield* session(repo, flags.session).pipe(
      Effect.provide(CliApp({ appServer: false, codexHome: null })),
    );
    if (!found)
      return yield* new HistoryFailed({
        message: `No session ${name} has worked in ${repo} (or its store hasn't written it yet)`,
      });
    yield* Console.log(`${title(found)} (${found.thread.id})`);
    const declared = new Map(
      declarationsIn(found.thread.id, found.entries).flatMap((d) =>
        (d.turns ?? []).map((n) => [n, d.sha.slice(0, 8)] as const),
      ),
    );
    for (const [i, t] of splitTurns(found.entries).entries()) {
      const at = (t.prompt?.at ?? t.entries[0]?.at ?? "").slice(0, 16).replace("T", " ");
      const text = t.prompt ? firstLine(t.prompt.text) : "(no prompt)";
      const linked = declared.get(i + 1);
      yield* Console.log(`T${i + 1}  ${at}  ${text}${linked ? `  → ${linked}` : ""}`);
    }
  }),
).pipe(
  Command.withDescription("List a session's turns, numbered as `history link --turns` takes them"),
);

const link = Command.make(
  "link",
  {
    repo: repoFlag,
    sha: Flag.string("sha").pipe(Flag.withDescription("The commit (any revision: HEAD, a SHA)")),
    turns: Flag.string("turns").pipe(
      Flag.withDescription(
        "The turns that produced it, e.g. 3-5,9 (`history turns` lists them); default: the turns since this session's previous declaration, through this one",
      ),
      Flag.optional,
    ),
    session: sessionFlag,
    note: Flag.string("note").pipe(Flag.withDescription("Why, in a sentence"), Flag.optional),
  },
  Effect.fn("toolreader history link")(function* (flags) {
    const repo = (yield* Path.Path).resolve(flags.repo);
    const sha = yield* commitSha(repo, flags.sha);
    const spec = Option.getOrNull(flags.turns);
    const numbers = spec === null ? null : parseTurns(spec);
    if (spec !== null && numbers === null)
      return yield* new HistoryFailed({
        message: `--turns must look like 3 or 3-5,9, got "${spec}"`,
      });
    if (spec === null && Option.isSome(flags.session))
      return yield* new HistoryFailed({ message: "With --session, name its turns with --turns" });
    const { name, found, own } = yield* session(repo, flags.session).pipe(
      Effect.provide(CliApp({ appServer: false, codexHome: null })),
    );
    if (!found && !own)
      return yield* new HistoryFailed({ message: `No session ${name} has worked in ${repo}` });
    const count = found ? splitTurns(found.entries).length : null;
    const beyond = numbers?.find((n) => count !== null && n > count);
    if (beyond !== undefined)
      return yield* new HistoryFailed({
        message: `${name} has ${count} turns; there is no T${beyond}`,
      });
    // Without --turns: what `history sync` will take, from where this session last declared.
    const previous = found ? (declarationsIn(found.thread.id, found.entries).at(-1)?.turn ?? 0) : 0;
    const shown =
      numbers !== null
        ? ranges(numbers)
        : count !== null
          ? `T${previous + 1} through the current turn`
          : "this session's turns since its last declaration";
    yield* Console.log(
      `${declaredLine("link", sha)} (${shown} of ${found ? `"${title(found)}"` : name})`,
    );
    if (!found)
      yield* Console.log(
        `  ${name} isn't in its session store yet; \`history sync\` resolves it once it is`,
      );
  }),
).pipe(
  Command.withDescription(
    "Declare which turns of this session (or another) produced a commit; history sync applies it",
  ),
);

const unlink = Command.make(
  "unlink",
  {
    repo: repoFlag,
    sha: Flag.string("sha").pipe(Flag.withDescription("The commit (any revision: HEAD, a SHA)")),
    session: sessionFlag,
  },
  Effect.fn("toolreader history unlink")(function* (flags) {
    const repo = (yield* Path.Path).resolve(flags.repo);
    const sha = yield* commitSha(repo, flags.sha);
    const { name, found, own } = yield* session(repo, flags.session).pipe(
      Effect.provide(CliApp({ appServer: false, codexHome: null })),
    );
    if (!found && !own)
      return yield* new HistoryFailed({ message: `No session ${name} has worked in ${repo}` });
    yield* Console.log(
      `${declaredLine("unlink", sha)} (${found ? `"${title(found)}"` : name} didn't produce it)`,
    );
  }),
).pipe(Command.withDescription("Declare that a session didn't produce a commit"));

const ToolUse = Schema.Struct({
  tool_name: Schema.optional(Schema.String),
  // Claude Code sends the command as a string; Codex may send its argv.
  tool_input: Schema.optional(
    Schema.Struct({
      command: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
    }),
  ),
});
const decodeToolUse = Schema.decodeUnknownOption(Schema.fromJsonString(ToolUse));
const Reminder = Schema.fromJsonString(
  Schema.Struct({
    hookSpecificOutput: Schema.Struct({
      hookEventName: Schema.Literal("PostToolUse"),
      additionalContext: Schema.String,
    }),
  }),
);
const encodeReminder = Schema.encodeSync(Reminder);

/**
 * The `PostToolUse` hook of Claude Code and Codex (`history skill install` registers it in
 * `.claude/settings.json` and `.codex/hooks.json`): after a Bash command that ran `git commit`, it puts a reminder to
 * declare in the agent's context. Silent otherwise, and it never fails the agent's command.
 */
const remind = Command.make(
  "remind",
  {},
  Effect.fn("toolreader history remind")(function* () {
    const input = yield* Effect.flatMap(Stdio.Stdio, (stdio) =>
      stdio.stdin.pipe(Stream.decodeText(), Stream.mkString),
    ).pipe(Effect.orElseSucceed(() => ""));
    const use = Option.getOrNull(decodeToolUse(input));
    const given = use?.tool_input?.command;
    // An argv: its shell script when it is `sh -c …`, else the words.
    const command =
      typeof given === "string" || given === undefined
        ? given
        : given.length >= 3 && /^-\w*c$/.test(given[1]!)
          ? given.slice(2).join(" ")
          : given.join(" ");
    if (use?.tool_name !== "Bash" || !command || !isGitCommit(command)) return;
    yield* Console.log(
      encodeReminder({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext:
            'You just made a git commit. Declare which of your turns produced it: `toolreader history link --sha HEAD --note "<what these turns did>"` (add `--turns 3-5` when only some did; `toolreader history turns` lists them). The toolreader-history skill has the details.',
        },
      }),
    );
  }),
).pipe(
  Command.withDescription(
    "The agents' hook after each Bash command: reminds the agent to declare a commit it just made",
  ),
);

export const declareCommands = [turns, link, unlink, remind] as const;
