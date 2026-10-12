// The checkpoint hooks (docs/design/checkpoints.requirements.md, FR-C2..C9), and the commands
// they run. Only a repo with `git config toolreader.checkpoints true` (what `hook install` sets)
// does anything; elsewhere the git hooks exit in shell, before Node starts.
//   toolreader checkpoint hook install|uninstall [--repo PATH]   opts the repo in or out
//   toolreader checkpoint hook stop [PAYLOAD]     an agent's Stop hook (Claude Code: stdin; Codex
//                                                 notify: the JSON argument)
//   toolreader checkpoint rewrite [--repo PATH] [--hook]   git's `old new` pairs on stdin
// - pre-push: `checkpoint collect --range <pushed> --hook` per pushed branch, in the background.
// - post-rewrite: `checkpoint rewrite --hook`, in the background.
// - commit-msg: the ledger's (`Agent-Session` trailer), shared with `ledger hook install --commit`.
// - Stop: one line per finished turn in ~/.toolreader/pending.jsonl. Nothing reads it yet: it is
//   there to find a push's sessions faster than scanning every session store, once that is slow.
// Hooks never write to stdout and never fail git or the agent: what they did, and what failed,
// goes to ~/.toolreader/checkpoint.log.
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { LIMITS } from "../../core/backendApi.ts";
import { commitMsgHook, LEDGER_BRANCH, remoteWebUrl } from "../../core/ledger.ts";
import { redactText } from "../../core/proof.ts";
import { CheckpointApp, LedgerApp } from "../app.ts";
import {
  CheckpointFailed,
  CheckpointSink,
  type Flushed,
  type RewritePair,
  type Sent,
} from "./Checkpoints.ts";
import { Ledger } from "../Ledger.ts";
import { selfCommand } from "../ledgerCli.ts";
import { ServerConfig } from "../ServerConfig.ts";

export const CHECKPOINT_HOOK_MARKER = "# toolreader checkpoint hook";
/** The opt-in: hooks act only where this is true. */
export const OPT_IN_KEY = "toolreader.checkpoints";

const optedIn = `[ "$(git config --bool ${OPT_IN_KEY})" = true ] || exit 0`;

/**
 * Runs the lines on its stdin through `body` (each as `$line`) in one job, detached: git never
 * waits, a closed terminal (SIGHUP) doesn't end it, and git's own GIT_DIR (set for hooks in linked
 * worktrees) doesn't leak into the job's git calls.
 */
const detached = (body: string) => `(
  trap '' HUP
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
  ${body}
) >/dev/null 2>&1 &`;

/**
 * `pre-push`: uploads the sessions of the commits each branch push to origin carries. While the
 * push waits it only works out what the push adds (a few boundary SHAs: origin's branches move
 * once it lands, and thousands of them won't fit one argument). One detached job then waits for
 * git, asks origin itself whether it took each branch (a tracking ref may not exist, and a hook
 * manager's wrapper may exit before git does), and collects only what it took: a refused push
 * (branch protection, secret scanning) uploads nothing, and says so in the log. Tags are skipped.
 * TOOLREADER_PUSH_CONFIRM_TRIES (3 s apart, default 10) bounds the asking.
 */
export function checkpointPrePushHook(command: string): string {
  return `#!/bin/sh
${CHECKPOINT_HOOK_MARKER}: uploads agent history for pushed commits, in the background.
# Remove it with \`checkpoint hook uninstall\`. It never stops or slows a push.
${optedIn}
[ "$1" = origin ] || exit 0
repo=$(git rev-parse --show-toplevel) || exit 0
jobs=
while read -r local_ref local_sha remote_ref remote_sha; do
  case "$local_sha" in *[!0]*) ;; *) continue ;; esac
  case "$remote_ref" in refs/heads/${LEDGER_BRANCH}) continue ;; refs/heads/*) ;; *) continue ;; esac
  # New here: on none of origin's branches, nor in what a force push replaces.
  not=--remotes=origin
  case "$remote_sha" in
    *[!0]*) git cat-file -e "$remote_sha^{commit}" 2>/dev/null && not="$not $remote_sha" ;;
  esac
  [ -n "$(git rev-list -n 1 "$local_sha" --not $not)" ] || continue
  bounds=$(echo $(git rev-list --boundary "$local_sha" --not $not | sed -n 's/^-//p'))
  jobs="$jobs\${remote_ref#refs/heads/} $local_sha $local_sha\${bounds:+ --not $bounds}
"
done
[ -n "$jobs" ] || exit 0
pusher=$PPID
printf '%s' "$jobs" | ${detached(`while kill -0 "$pusher" 2>/dev/null; do sleep 1; done
  # Never a prompt from a background job.
  export GIT_TERMINAL_PROMPT=0
  [ -n "$GIT_SSH_COMMAND$(git -C "$repo" config core.sshCommand)" ] ||
    export GIT_SSH_COMMAND="ssh -o BatchMode=yes"
  url=$(git -C "$repo" remote get-url --push origin)
  # What origin has for a branch; an answer that takes over 20 s counts as none.
  ask() {
    out=$(mktemp) || return 0
    git -C "$repo" ls-remote "$url" "refs/heads/$1" >"$out" 2>/dev/null &
    lp=$!
    # Its own output elsewhere: the caller's $(...) would wait for the sleep otherwise.
    (sleep 20; kill "$lp" 2>/dev/null) >/dev/null 2>&1 &
    kp=$!
    wait "$lp" 2>/dev/null
    kill "$kp" 2>/dev/null
    cut -f1 "$out"
    rm -f "$out"
  }
  while read -r branch sha range; do
    took=
    tries=\${TOOLREADER_PUSH_CONFIRM_TRIES:-10}
    while [ "$tries" -gt 0 ]; do
      at=$(ask "$branch")
      # Or a later push already moved it on: what this push sent is under the new tip.
      { [ "$at" = "$sha" ] || { [ -n "$at" ] && git -C "$repo" merge-base --is-ancestor "$sha" "$at" 2>/dev/null; }; } && { took=1; break; }
      tries=$((tries - 1)); [ "$tries" -gt 0 ] && sleep 3
    done
    if [ -n "$took" ]; then
      ${command} checkpoint collect --repo "$repo" --range "$range" --hook </dev/null
    else
      mkdir -p "$HOME/.toolreader" &&
        printf '%s skipped %s: origin has %s, not %s (refused, or not there yet); nothing sent\\n' \\
          "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$branch" "\${at:-nothing}" "$sha" >> "$HOME/.toolreader/checkpoint.log"
    fi
  done`)}
exit 0
`;
}

/** `post-rewrite`: sends git's old → new pairs after an amend or rebase, detached. */
export function checkpointPostRewriteHook(command: string): string {
  return `#!/bin/sh
${CHECKPOINT_HOOK_MARKER}: records which commits an amend or rebase replaced, in the background.
# Remove it with \`checkpoint hook uninstall\`. It never stops git.
${optedIn}
repo=$(git rev-parse --show-toplevel) || exit 0
pairs=$(cut -d' ' -f1,2)
[ -n "$pairs" ] || exit 0
printf '%s\\n' "$pairs" | ${detached(`${command} checkpoint rewrite --repo "$repo" --hook`)}
exit 0
`;
}

const LOG_BYTES = 1024 * 1024;

export const mark = (result: Sent | "failed") =>
  result === "failed" || result === "rejected"
    ? "✗"
    : result === "exists" || result === "differs"
      ? "·"
      : result === "queued"
        ? "…"
        : "✓";

/** What the outbox sent, why it stopped, and what waits for another backend. */
export const flushedLines = (flushed: Flushed) => [
  ...flushed.sent.map(
    (f) =>
      `${mark(f.result)} ${f.id}  ${f.result} (from the outbox)${f.detail ? `: ${f.detail}` : ""}`,
  ),
  ...(flushed.blocked ? [`… the outbox waits: ${flushed.blocked}`] : []),
  ...(flushed.elsewhere > 0
    ? [
        `· ${flushed.elsewhere} queued for another backend, workspace or toolreader version, left in ~/.toolreader/outbox (delete them there if that backend is gone)`,
      ]
    : []),
];

/**
 * Past LOG_BYTES, a file moves to `<file>.1` (one older file is kept), so it never grows past
 * about twice that. Another hook may have moved it first.
 */
const rotate = (file: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.stat(file).pipe(
      Effect.flatMap((s) =>
        Number(s.size) > LOG_BYTES ? fs.rename(file, `${file}.1`) : Effect.void,
      ),
      Effect.ignore,
    ),
  );

/** Where hooks report: what they stored, queued or skipped, and what failed. */
export const appendLog = Effect.fn("checkpointHooks.appendLog")(function* (
  title: string,
  lines: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { home } = yield* ServerConfig;
  const dir = path.join(home, ".toolreader");
  const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
  const log = path.join(dir, "checkpoint.log");
  yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 });
  yield* rotate(log);
  yield* fs.writeFileString(log, [`${at} ${title}`, ...lines.map((l) => `  ${l}`), ""].join("\n"), {
    flag: "a",
    mode: 0o600,
  });
}, Effect.provide(ServerConfig.layer));

/** A failure or crash, as one redacted line for the log. */
const causeMessage = (cause: Cause.Cause<unknown>) => {
  const e = Cause.squash(cause);
  const message =
    typeof e === "object" && e !== null && "message" in e ? String(e.message) : String(e);
  return redactText(message).text;
};

/**
 * Runs `work` (lines to report) as a command or as a hook. A hook logs the lines, or the failure,
 * and succeeds; a command prints them and fails as it would.
 */
export const reportAs = <E extends { readonly message: string }, R>(
  hook: boolean,
  title: string,
  work: Effect.Effect<
    { readonly lines: ReadonlyArray<string>; readonly failure: string | null },
    E,
    R
  >,
) =>
  hook
    ? work.pipe(
        // Crashes too: a detached job has nowhere else to say it died.
        Effect.catchCause((cause) =>
          Effect.succeed({ lines: [`✗ ${causeMessage(cause)}`], failure: null }),
        ),
        Effect.flatMap(({ lines, failure }) =>
          appendLog(title, failure ? [...lines, `✗ ${failure}`] : lines),
        ),
        Effect.ignore,
      )
    : work.pipe(
        Effect.flatMap(({ lines, failure }) =>
          Effect.andThen(
            Effect.forEach(lines, (l) => Console.log(l), { discard: true }),
            failure ? Effect.fail(new CheckpointFailed({ message: failure })) : Effect.void,
          ),
        ),
      );

const git = (repo: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
    spawner.string(ChildProcess.make("git", ["-C", repo, ...args])),
  ).pipe(
    Effect.map((s) => s.trim()),
    Effect.mapError((e) => new CheckpointFailed({ message: e.message })),
  );

/** `owner/name` from origin, as checkpoints name the repo; the backend has no other name for it. */
const originName = Effect.fn("checkpointHooks.originName")(function* (repo: string) {
  const remote = yield* git(repo, ["remote", "get-url", "origin"]).pipe(Effect.option);
  const web = remoteWebUrl(Option.isSome(remote) ? redactText(remote.value).text : null);
  if (!web)
    return yield* new CheckpointFailed({
      message: `${repo} has no origin remote; the backend names repos owner/name`,
    });
  return new URL(web).pathname.slice(1);
});

const repoFlag = Flag.string("repo").pipe(
  Flag.withDescription("Repository (any path inside it)"),
  Flag.withDefault("."),
);
export const hookFlag = Flag.boolean("hook").pipe(
  Flag.withDescription("Run as a git hook: report to ~/.toolreader/checkpoint.log, never fail"),
);

const readStdin = Effect.flatMap(Stdio.Stdio, (stdio) =>
  stdio.stdin.pipe(Stream.decodeText(), Stream.mkString),
);

const Sha = /^[0-9a-f]{4,64}$/;

export const rewriteCommand = Command.make(
  "rewrite",
  { repo: repoFlag, hook: hookFlag },
  Effect.fn("toolreader checkpoint rewrite")(function* ({ repo, hook }) {
    const path = yield* Path.Path;
    const dir = path.resolve(repo);
    const work = Effect.gen(function* () {
      const pairs: RewritePair[] = (yield* readStdin)
        .split("\n")
        .map((l) => l.trim().split(/\s+/))
        .filter(([o, n]) => o && n && Sha.test(o) && Sha.test(n))
        .map(([oldSha, newSha]) => ({ oldSha: oldSha!, newSha: newSha! }));
      if (pairs.length === 0) return { lines: ["no pairs on stdin"], failure: null };
      const name = yield* originName(dir);
      const sink = yield* CheckpointSink;
      // Nothing else: an amend is commit time, and the outbox waits for the push (FR-C5).
      const lines: string[] = [];
      let failure: string | null = null;
      for (let i = 0; i < pairs.length; i += LIMITS.pairs) {
        const chunk = pairs.slice(i, i + LIMITS.pairs);
        const { result, detail } = yield* sink.rewrite(name, chunk);
        lines.push(
          `${name}: ${chunk.length} rewritten commit${chunk.length === 1 ? "" : "s"} ${result}${detail ? ` (${detail})` : ""}`,
        );
        if (result === "rejected") failure = detail;
      }
      return { lines, failure };
    }).pipe(Effect.provide(CheckpointApp()));
    yield* reportAs(hook, `rewrite in ${dir}`, work);
  }),
).pipe(
  Command.withDescription(
    "Record which commits an amend or rebase replaced (git's `old new` pairs on stdin)",
  ),
);

const StopPayload = Schema.Struct({
  // Claude Code's Stop hook, on stdin.
  session_id: Schema.optional(Schema.String),
  transcript_path: Schema.optional(Schema.String),
  // Codex's notify, as its argument.
  "thread-id": Schema.optional(Schema.String),
  "turn-id": Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
});
const decodeStopPayload = Schema.decodeUnknownEffect(Schema.fromJsonString(StopPayload));
const PendingLine = Schema.Struct({
  session: Schema.String,
  transcript: Schema.NullOr(Schema.String),
  cwd: Schema.String,
  turn: Schema.NullOr(Schema.String),
  at: Schema.String,
});
const encodePendingLine = Schema.encodeEffect(Schema.fromJsonString(PendingLine));

/** One line in ~/.toolreader/pending.jsonl for a finished turn in an opted-in repo; sends nothing. */
const stop = Command.make(
  "stop",
  {
    payload: Argument.string("payload").pipe(
      Argument.withDescription("Codex notify's JSON (Claude Code's comes on stdin)"),
      Argument.optional,
    ),
  },
  Effect.fn("toolreader checkpoint hook stop")(function* ({ payload }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const work = Effect.gen(function* () {
      const { home } = yield* ServerConfig;
      const input = yield* decodeStopPayload(
        Option.isSome(payload) ? payload.value : yield* readStdin,
      );
      const session = input.session_id
        ? `claude-code:${input.session_id}`
        : input["thread-id"]
          ? `codex:${input["thread-id"]}`
          : null;
      if (!session || !input.cwd) return;
      const opted = yield* git(input.cwd, ["config", "--bool", OPT_IN_KEY]).pipe(
        Effect.orElseSucceed(() => ""),
      );
      if (opted !== "true") return;
      const line = yield* encodePendingLine({
        session,
        transcript: input.transcript_path ?? null,
        cwd: input.cwd,
        turn: input["turn-id"] ?? null,
        at: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
      });
      const dir = path.join(home, ".toolreader");
      const pending = path.join(dir, "pending.jsonl");
      yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 });
      yield* rotate(pending);
      yield* fs.writeFileString(pending, `${line}\n`, {
        flag: "a",
        mode: 0o600,
      });
    });
    // Never fails the agent's turn.
    yield* work.pipe(
      Effect.provide(ServerConfig.layer),
      Effect.catchCause((cause) =>
        appendLog("stop hook", [`✗ ${causeMessage(cause)}`]).pipe(Effect.ignore),
      ),
    );
  }),
).pipe(Command.withDescription("An agent's Stop hook: note the session for the next push"));

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const installer = (action: "install" | "uninstall") =>
  Command.make(
    action,
    { repo: repoFlag },
    Effect.fn(`toolreader checkpoint hook ${action}`)(function* ({ repo }) {
      const path = yield* Path.Path;
      const dir = path.resolve(repo);
      const self = selfCommand(path);
      const lines = yield* Effect.gen(function* () {
        const ledger = yield* Ledger;
        const file = (name: string, script: string) =>
          ledger.hookFile(dir, name, script, action, CHECKPOINT_HOOK_MARKER);
        const out: string[] = [];
        // Off first: whatever happens to the files below, the hooks stop acting.
        if (action === "uninstall") {
          yield* git(dir, ["config", "--unset", OPT_IN_KEY]).pipe(Effect.ignore);
          out.push(`Unset ${OPT_IN_KEY}: hooks do nothing in this repo.`);
        }
        // Install stops at the first conflict, before opting in; uninstall removes what it can.
        const failures: string[] = [];
        const attempt = (effect: Effect.Effect<string, { readonly message: string }>) =>
          action === "install"
            ? effect
            : effect.pipe(Effect.catch((e) => Effect.sync(() => (failures.push(e.message), ""))));
        out.push(yield* attempt(file("pre-push", checkpointPrePushHook(self))));
        out.push(yield* attempt(file("post-rewrite", checkpointPostRewriteHook(self))));
        // Shared with `ledger hook install --commit`, and removed with either's uninstall. Someone
        // else's commit-msg is a warning: without it, commits made by agents just get no trailer.
        const commitMsg = yield* ledger.hookFile(dir, "commit-msg", commitMsgHook(), action).pipe(
          Effect.catch((e) =>
            // Someone else's (or an edited) hook is a warning; ours that won't go is a failure.
            action === "uninstall" && !e.message.includes("leaving it alone")
              ? Effect.sync(() => (failures.push(e.message), ""))
              : Effect.succeed(
                  action === "uninstall"
                    ? `Kept commit-msg: ${e.message}`
                    : `No Agent-Session trailers: ${e.message}`,
                ),
          ),
        );
        out.push(
          action === "uninstall" && commitMsg.startsWith("Removed")
            ? `${commitMsg} (Agent-Session trailers; \`ledger hook install --commit\` adds it back)`
            : commitMsg,
        );
        if (failures.length > 0)
          return yield* new CheckpointFailed({
            message: [...out.filter(Boolean), ...failures].join("\n"),
          });
        if (action === "install") {
          yield* git(dir, ["config", OPT_IN_KEY, "true"]);
          out.push(`Set ${OPT_IN_KEY}=true: hooks act in this repo.`);
        }
        return out;
      }).pipe(Effect.provide(LedgerApp({ appServer: false, codexHome: null })));
      for (const l of lines) yield* Console.log(l);
      if (action === "install") {
        const stopCommand = `${self} checkpoint hook stop`;
        const claude = {
          hooks: { Stop: [{ hooks: [{ type: "command", command: stopCommand }] }] },
        };
        const codex = [
          process.execPath,
          path.resolve(process.argv[1]!),
          "checkpoint",
          "hook",
          "stop",
        ];
        yield* Console.log(
          [
            "",
            "To note agent sessions as their turns end (optional), add the Stop hook:",
            `  Claude Code (~/.claude/settings.json): ${encodeJson(claude)}`,
            `  Codex (~/.codex/config.toml): notify = ${encodeJson(codex)}`,
          ].join("\n"),
        );
      }
    }),
  ).pipe(
    Command.withDescription(
      action === "install"
        ? "Opt this repo in and install its checkpoint hooks (pre-push, post-rewrite, commit-msg)"
        : "Opt this repo out and remove its checkpoint hooks",
    ),
  );

export const hookCommand = Command.make("hook").pipe(
  Command.withDescription(
    "Checkpoint hooks: install them in a repo, or run as an agent's Stop hook",
  ),
  Command.withSubcommands([installer("install"), installer("uninstall"), stop]),
);
