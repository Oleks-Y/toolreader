// `toolreader ledger`:
//   toolreader ledger sync [--repo PATH] [--range A..B] [--source auto|t3|codex-app-server|codex-rollouts|claude-transcripts]
//                         [--codex-home DIR] [--max-output BYTES] [--no-outputs] [--push]
//                         [--match-sessions | --session ID ...]
//                         [--sanitize anonymize|remove|off] [--sanitize-agent on|off]
//   toolreader ledger sanitize [--repo PATH] [--mode anonymize|remove] [--agent on|off] [--push]
//                                                               rewrite agent-ledger as one sanitized commit
//   toolreader ledger show [--repo PATH] [--range A..B]          list commits and their history
//   toolreader ledger site [--repo PATH] [--range A..B] [--out DIR]  static page of the range
//   toolreader ledger hook install|uninstall [--repo PATH] [--commit]
//                                         pre-push hook: sync pushed commits, --push; --commit also
//                                         adds an Agent-Session trailer to commits made by an agent
//   toolreader ledger link REV --session ID [--role coder|reviewer|committer]   say a thread made it
//   toolreader ledger unlink REV --session ID
//   toolreader ledger note REV TEXT [--file PATH]
//   toolreader ledger review [REV] [--session ID]   from an agent: link its own session as reviewer
//   toolreader ledger explain [REV]                 one commit: its threads, files and notes
// The range defaults to <default branch>..HEAD. Without --push, share it with `git push origin agent-ledger`.
// Sanitizing (Sanitizer.ts) follows the repo's .toolreader.json unless a flag says otherwise.
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Argument, Command, Flag } from "effect/unstable/cli";

import {
  isStale,
  LEDGER_BRANCH,
  LINK_ROLES,
  sessionFromEnv,
  type LedgerEntry,
  type LedgerLink,
} from "../core/ledger.ts";
import { SANITIZE_MODES } from "../core/sanitize.ts";
import { publicRange } from "../core/ledgerSite.ts";
import { redactText } from "../core/proof.ts";
import { LedgerFailed } from "../core/api.ts";
import { LedgerApp } from "./app.ts";
import {
  Ledger,
  LEDGER_SOURCES,
  SYNC_DEFAULTS,
  type Assertion,
  type SanitizeSummary,
} from "./Ledger.ts";
import { ServerConfig } from "./ServerConfig.ts";

const repo = Flag.string("repo").pipe(
  Flag.withDescription("Repository (any path inside it)"),
  Flag.withDefault("."),
);
const range = Flag.string("range").pipe(
  Flag.withDescription(
    "Commits to sync, as `git log` takes them: main..HEAD, or `SHA --not --remotes=origin` (default: <default branch>..HEAD)",
  ),
  Flag.optional,
);
const offline = LedgerApp({ appServer: false, codexHome: null });
const agentFlag = (name: string) =>
  Flag.choice(name, ["on", "off"]).pipe(
    Flag.withDescription(
      "Have an ACP agent (default: codex-acp with gpt-6-luna) find what else is private first (default: the config's, else off)",
    ),
    Flag.optional,
  );
const onOff = (o: Option.Option<"on" | "off">) =>
  Option.getOrNull(Option.map(o, (v) => v === "on"));
const sanitizedLine = (s: SanitizeSummary) =>
  s.mode === "off"
    ? "not sanitized"
    : `sanitized (${s.mode}): ${s.hits} hidden${s.spans === null ? "" : `, ${s.spans} found by the agent`}`;
/** Commit subjects come straight from git; CI logs are as public as the page. */
const subject = (s: string) => redactText(s).text;

const sync = Command.make(
  "sync",
  {
    repo,
    range,
    source: Flag.choice("source", LEDGER_SOURCES).pipe(
      Flag.withDescription(
        "Where sessions come from. auto: T3 if its database exists, plus Codex rollout files and Claude Code transcripts",
      ),
      Flag.withDefault(SYNC_DEFAULTS.source),
    ),
    codexHome: Flag.string("codex-home").pipe(
      Flag.withDescription("Codex home with sessions/ (default: $CODEX_HOME or ~/.codex)"),
      Flag.optional,
    ),
    maxOutput: Flag.integer("max-output").pipe(
      Flag.withDescription("Bytes kept per action output, head and tail (0 keeps it whole)"),
      Flag.withDefault(SYNC_DEFAULTS.maxOutput),
    ),
    noOutputs: Flag.boolean("no-outputs").pipe(
      Flag.withDescription("Leave command and tool outputs out (they are redacted otherwise)"),
    ),
    matchSessions: Flag.boolean("match-sessions").pipe(
      Flag.withDescription(
        "Tie a commit no `git commit` action made to the one session here that edited files and ended before it (safe with a job-local CODEX_HOME)",
      ),
    ),
    session: Flag.string("session").pipe(
      Flag.withDescription("Tie such commits to this session (repeatable)"),
      Flag.atLeast(0),
    ),
    push: Flag.boolean("push").pipe(
      Flag.withDescription(
        "Write on top of origin's agent-ledger and push it, retrying if another push wins",
      ),
    ),
    sanitize: Flag.choice("sanitize", [...SANITIZE_MODES, "off"]).pipe(
      Flag.withDescription(
        "Hide what belongs to this machine, not the project: anonymize (placeholders) or remove (default: the config's, else anonymize)",
      ),
      Flag.optional,
    ),
    sanitizeAgent: agentFlag("sanitize-agent"),
  },
  Effect.fn(function* ({
    repo,
    range,
    source,
    codexHome,
    maxOutput,
    noOutputs,
    push,
    matchSessions,
    session,
    sanitize,
    sanitizeAgent,
  }) {
    const path = yield* Path.Path;
    const result = yield* Effect.flatMap(Ledger, (ledger) =>
      ledger.sync(repo, Option.getOrNull(range), {
        outputs: !noOutputs,
        maxOutput,
        source,
        push,
        matchSessions,
        sessions: session,
        sanitize: Option.getOrNull(sanitize),
        sanitizeAgent: onOff(sanitizeAgent),
      }),
    ).pipe(
      Effect.provide(
        LedgerApp({
          appServer: source === "codex-app-server",
          codexHome: Option.getOrNull(Option.map(codexHome, (dir) => path.resolve(dir))),
        }),
      ),
    );
    yield* Console.log(
      `${result.range} (${result.sources.join(" + ") || "no sources"}): ${result.added.length} added, ${result.existing} already in the ledger`,
    );
    if (result.added.length > 0) yield* Console.log(`  ${sanitizedLine(result.sanitized)}`);
    for (const a of result.added) {
      for (const l of a.links)
        yield* Console.log(
          `  + ${a.commit.sha.slice(0, 8)} ${subject(a.commit.subject)}  ← ${l.title} (${l.role}, ${l.actions} actions, by ${l.via})`,
        );
    }
    for (const { commit: c, sessions } of result.ambiguous) {
      yield* Console.log(
        `  ? ${c.sha.slice(0, 8)} ${subject(c.subject)}  (ambiguous: ${sessions.join(", ")}; pick one with --session)`,
      );
    }
    for (const c of result.unmatched) {
      yield* Console.log(
        `  · ${c.sha.slice(0, 8)} ${subject(c.subject)}  (no agent history found; files recorded as untracked)`,
      );
    }
    if (result.pushed) yield* Console.log(`Pushed ${LEDGER_BRANCH} ${result.pushed.slice(0, 8)}`);
    else if (!push && result.added.length + result.unmatched.length > 0)
      yield* Console.log(`Push it with: git push origin ${LEDGER_BRANCH}`);
  }),
).pipe(Command.withDescription("Write ledger entries for agent-made commits in a range"));

const show = Command.make(
  "show",
  { repo, range },
  Effect.fn(function* ({ repo, range }) {
    // Its output goes to CI logs and job summaries: print the public view.
    const view = yield* Effect.gen(function* () {
      const { home } = yield* ServerConfig;
      const ledger = yield* Ledger;
      return publicRange(yield* ledger.range(repo, Option.getOrNull(range)), home);
    }).pipe(Effect.provide(offline));
    yield* Console.log(`${view.repo} ${view.range}`);
    for (const c of view.commits) {
      const e = c.entry;
      const threads = e?.links.map((l) => `${l.thread.title} (${l.role}, by ${l.via})`) ?? [];
      const detail =
        threads.length > 0
          ? `${threads.join("; ")}${c.matchedBy === "patch-id" ? " · found by patch-id" : ""}`
          : "no agent history";
      yield* Console.log(`  ${c.commit.sha.slice(0, 8)} ${c.commit.subject}  — ${detail}`);
    }
  }),
).pipe(Command.withDescription("List commits in a range with their agent history"));

const site = Command.make(
  "site",
  {
    repo,
    range,
    out: Flag.string("out").pipe(
      Flag.withDescription("Directory to write index.html into"),
      Flag.withDefault("ledger-site"),
    ),
  },
  Effect.fn(function* ({ repo, range, out }) {
    const { file, view } = yield* Effect.flatMap(Ledger, (ledger) =>
      ledger.site(repo, Option.getOrNull(range), out),
    ).pipe(Effect.provide(offline));
    const withHistory = view.commits.filter((c) => (c.entry?.links.length ?? 0) > 0).length;
    yield* Console.log(
      `${file}\n${view.range}: ${view.commits.length} commits, ${withHistory} with agent history`,
    );
  }),
).pipe(
  Command.withDescription(
    "Write a self-contained page of a range's agent history (opens from file:// or any static host)",
  ),
);

const sanitize = Command.make(
  "sanitize",
  {
    repo,
    mode: Flag.choice("mode", SANITIZE_MODES).pipe(
      Flag.withDescription(
        "anonymize (placeholders) or remove (default: the config's, else anonymize)",
      ),
      Flag.optional,
    ),
    agent: agentFlag("agent"),
    push: Flag.boolean("push").pipe(
      Flag.withDescription("Replace origin's agent-ledger too, unless it moved since it was read"),
    ),
  },
  Effect.fn(function* ({ repo, mode, agent, push }) {
    const result = yield* Effect.flatMap(Ledger, (ledger) =>
      ledger.sanitize(repo, { mode: Option.getOrNull(mode), agent: onOff(agent), push }),
    ).pipe(Effect.provide(offline));
    yield* Console.log(
      `${result.entries} entries, ${sanitizedLine(result)}; ${LEDGER_BRANCH} is now ${result.head?.slice(0, 8) ?? "empty"}, one commit`,
    );
    if (result.pushed) yield* Console.log(`Pushed ${LEDGER_BRANCH} ${result.pushed.slice(0, 8)}`);
    else if (result.entries > 0)
      yield* Console.log(
        `Replace origin's with: git push --force-with-lease origin ${LEDGER_BRANCH}`,
      );
  }),
).pipe(
  Command.withDescription(
    "Rewrite agent-ledger as one commit of its entries sanitized, leaving no earlier version in its history",
  ),
);

const hook = Command.make(
  "hook",
  {
    action: Argument.choice("action", ["install", "uninstall"]),
    repo,
    commit: Flag.boolean("commit").pipe(
      Flag.withDescription(
        "Also install a commit-msg hook: a commit made inside an agent session gets an Agent-Session trailer",
      ),
    ),
  },
  Effect.fn(function* ({ action, repo, commit }) {
    // The hook runs this same CLI (the script node started: bin.ts, or the bundled dist/bin.mjs),
    // with absolute paths so it works from any shell.
    const path = yield* Path.Path;
    const self = [process.execPath, path.resolve(process.argv[1]!)]
      .map((a) => `'${a.replace(/'/g, `'\\''`)}'`)
      .concat("ledger");
    const message = yield* Effect.flatMap(Ledger, (ledger) =>
      ledger.hook(repo, action, self.join(" "), { commit }),
    ).pipe(Effect.provide(offline));
    yield* Console.log(message);
  }),
).pipe(
  Command.withDescription(
    "Install or remove a pre-push hook that syncs the pushed commits and pushes agent-ledger",
  ),
);

const rev = Argument.string("rev").pipe(
  Argument.withDescription("The commit (default: HEAD)"),
  Argument.withDefault("HEAD"),
);
const sessionFlag = Flag.string("session").pipe(
  Flag.withDescription("A thread id, codex:<id>, or claude-code:<id>"),
);

/** One commit's entry as `explain` prints it, from the public view. */
function explainLines(entry: LedgerEntry | null, sha: string): string[] {
  if (!entry) return ["  no ledger entry; run `toolreader ledger sync` or `ledger link`"];
  const lines: string[] = [];
  for (const l of entry.links) {
    const actions = l.entries.filter((e) => e.type === "action").length;
    const stale = isStale(l, sha) ? `  stale: reviewed ${l.reviewedSha!.slice(0, 8)}` : "";
    const parent = l.thread.parent ? `, subagent of ${l.thread.parent}` : "";
    lines.push(
      `  ${l.role.padEnd(9)} ${l.thread.title}  (by ${l.via}, ${actions} actions${parent})${stale}`,
    );
  }
  for (const f of entry.files) lines.push(`  ${f.bucket.padEnd(10)} ${f.path}`);
  for (const n of entry.notes) lines.push(`  note${n.file ? ` on ${n.file}` : ""}: ${n.text}`);
  return lines;
}

const explain = Command.make(
  "explain",
  { repo, rev },
  Effect.fn(function* ({ repo, rev }) {
    const view = yield* Effect.gen(function* () {
      const { home } = yield* ServerConfig;
      const ledger = yield* Ledger;
      return publicRange(yield* ledger.range(repo, `-1 ${rev}`), home);
    }).pipe(Effect.provide(offline));
    for (const c of view.commits) {
      yield* Console.log(
        `${c.commit.sha.slice(0, 8)} ${c.commit.subject}${c.matchedBy === "patch-id" ? "  (found by patch-id)" : ""}`,
      );
      for (const line of explainLines(c.entry, c.commit.sha)) yield* Console.log(line);
    }
  }),
).pipe(Command.withDescription("Show one commit's threads, files and notes"));

const LOCAL_ONLY = `Local ${LEDGER_BRANCH} only; share it with git push origin ${LEDGER_BRANCH} (or the next sync --push).`;
const runAssert = (repo: string, rev: string, change: Assertion) =>
  Effect.flatMap(Ledger, (ledger) => ledger.assert(repo, rev, change)).pipe(
    Effect.provide(offline),
  );
const linkedLine = ({ entry, linked }: { entry: LedgerEntry; linked: LedgerLink | null }) =>
  `${entry.commit.sha.slice(0, 8)} ← ${subject(linked?.thread.title ?? "?")} (${linked?.role ?? "?"}, asserted)`;

const link = Command.make(
  "link",
  {
    repo,
    rev,
    session: sessionFlag,
    role: Flag.choice("role", LINK_ROLES).pipe(
      Flag.withDescription("What the thread did for the commit"),
      Flag.withDefault("coder"),
    ),
  },
  Effect.fn(function* ({ repo, rev, session, role }) {
    const result = yield* runAssert(repo, rev, {
      link: { session, role, reviewed: role === "reviewer" },
    });
    yield* Console.log(`${linkedLine(result)}\n${LOCAL_ONLY}`);
  }),
).pipe(Command.withDescription("Record that a thread worked on a commit (sync keeps it)"));

const unlink = Command.make(
  "unlink",
  { repo, rev, session: sessionFlag },
  Effect.fn(function* ({ repo, rev, session }) {
    const { entry } = yield* runAssert(repo, rev, { unlink: session });
    yield* Console.log(
      `${entry.commit.sha.slice(0, 8)}: ${entry.links.length} threads left\n${LOCAL_ONLY}`,
    );
  }),
).pipe(Command.withDescription("Remove a thread from a commit's entry"));

const note = Command.make(
  "note",
  {
    repo,
    rev: Argument.string("rev").pipe(Argument.withDescription("The commit")),
    text: Argument.string("text").pipe(Argument.withDescription("The note")),
    file: Flag.string("file").pipe(
      Flag.withDescription("A file the commit changed, if the note is about it"),
      Flag.optional,
    ),
  },
  Effect.fn(function* ({ repo, rev, text, file }) {
    const { entry } = yield* runAssert(repo, rev, {
      note: { text, file: Option.getOrNull(file) },
    });
    yield* Console.log(
      `${entry.commit.sha.slice(0, 8)}: ${entry.notes.length} notes\n${LOCAL_ONLY}`,
    );
  }),
).pipe(Command.withDescription("Add a note to a commit, e.g. what was changed by hand"));

const review = Command.make(
  "review",
  {
    repo,
    rev,
    session: sessionFlag.pipe(
      Flag.withDescription("The reviewing thread (default: the agent session this runs in)"),
      Flag.optional,
    ),
  },
  Effect.fn(function* ({ repo, rev, session: named }) {
    const session = Option.getOrNull(named) ?? sessionFromEnv(process.env);
    if (!session)
      return yield* new LedgerFailed({
        message: "Not in an agent session; name the reviewer with --session.",
      });
    const result = yield* runAssert(repo, rev, {
      link: { session, role: "reviewer", reviewed: true },
    });
    yield* Console.log(`${linkedLine(result)}\n${LOCAL_ONLY}`);
  }),
).pipe(
  Command.withDescription(
    "Record a review of a commit by the agent session this runs in (stale once the code changes)",
  ),
);

export const ledgerCommand = Command.make("ledger").pipe(
  Command.withDescription("Agent history per commit, kept on the agent-ledger branch"),
  Command.withSubcommands([sync, show, explain, link, unlink, note, review, site, sanitize, hook]),
);
