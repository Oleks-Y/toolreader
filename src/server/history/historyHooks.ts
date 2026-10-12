// The git hooks that keep a repo's agent history on the backend, once it opts in
// (`git config toolreader.history true`, what `history hook install` sets; elsewhere they exit in
// shell, before Node starts):
// - pre-push: `history sync --range <pushed> --hook` per branch, in the background, once origin
//   has taken the push.
// - commit-msg: an `Agent-Session` trailer on a commit made inside an agent session.
// Hooks never write to stdout and never fail git: what they did, and what failed, goes to
// ~/.toolreader/history.log. A sync that failed (the backend down) is retried by the next one.
import * as NodeCrypto from "node:crypto";

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { SESSION_TRAILER } from "../../core/ledger.ts";
import { redactText } from "../../core/proof.ts";
import { ServerConfig } from "../ServerConfig.ts";
import { HistoryFailed } from "./HistoryClient.ts";
import { hasSkill } from "./historySkill.ts";

export const HOOK_MARKER = "# toolreader history hook";
/** The opt-in: hooks act only where this is true. */
export const OPT_IN_KEY = "toolreader.history";

const optedIn = `[ "$(git config --bool ${OPT_IN_KEY})" = true ] || exit 0`;

/**
 * Runs the lines on its stdin through `body` in one job, detached: git never waits, a closed
 * terminal (SIGHUP) doesn't end it, and git's own GIT_DIR (set for hooks in linked worktrees)
 * doesn't leak into the job's git calls.
 */
const detached = (body: string) => `(
  trap '' HUP
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
  ${body}
) >/dev/null 2>&1 &`;

/**
 * `pre-push`: syncs the commits each branch push to origin carries. While the push waits it only
 * works out what the push adds (a few boundary SHAs: origin's branches move once it lands, and
 * thousands of them won't fit one argument). One detached job then waits for git, asks origin
 * whether it took each branch (a later push that built on it counts), and syncs only what it
 * took: a refused push sends nothing, and says so in the log. Tags are skipped.
 * TOOLREADER_PUSH_CONFIRM_TRIES (3 s apart, default 10) bounds the asking.
 */
export function prePushHook(command: string): string {
  return `#!/bin/sh
${HOOK_MARKER}: sends the agent history of pushed commits, in the background.
# Remove it with \`history hook uninstall\`. It never stops or slows a push.
${optedIn}
[ "$1" = origin ] || exit 0
repo=$(git rev-parse --show-toplevel) || exit 0
jobs=
while read -r local_ref local_sha remote_ref remote_sha; do
  case "$local_sha" in *[!0]*) ;; *) continue ;; esac
  case "$remote_ref" in refs/heads/*) ;; *) continue ;; esac
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
      { [ "$at" = "$sha" ] || { [ -n "$at" ] && git -C "$repo" merge-base --is-ancestor "$sha" "$at" 2>/dev/null; }; } && { took=1; break; }
      tries=$((tries - 1)); [ "$tries" -gt 0 ] && sleep 3
    done
    if [ -n "$took" ]; then
      ${command} history sync --repo "$repo" --range "$range" --hook </dev/null
    else
      (umask 077; mkdir -p "$HOME/.toolreader" &&
        printf '%s skipped %s: origin has %s, not %s (refused, or not there yet); nothing sent\\n' \\
          "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$branch" "\${at:-nothing}" "$sha" >> "$HOME/.toolreader/history.log")
    fi
  done`)}
exit 0
`;
}

/** `commit-msg`: names the agent session a commit is made in, from what agents export. */
export function commitMsgHook(): string {
  return `#!/bin/sh
${HOOK_MARKER}: names the agent session a commit comes from.
# Remove it with \`history hook uninstall\`. It never stops a commit.
# An emptied message aborts the commit; a trailer would turn it into one.
grep -q '^[[:space:]]*[^#[:space:]]' "$1" || exit 0
if [ -n "$CODEX_THREAD_ID" ]; then session="codex:$CODEX_THREAD_ID"
elif [ -n "$CLAUDE_CODE_SESSION_ID" ]; then session="claude-code:$CLAUDE_CODE_SESSION_ID"
else exit 0
fi
git interpret-trailers --in-place --if-exists addIfDifferent \\
  --trailer "${SESSION_TRAILER}: $session" "$1" 2>/dev/null
exit 0
`;
}

/** This same CLI as a hook runs it: node and the script it started, quoted, absolute. */
export const selfCommand = (path: Path.Path) =>
  [process.execPath, path.resolve(process.argv[1]!)]
    .map((a) => `'${a.replace(/'/g, `'\\''`)}'`)
    .join(" ");

const SEAL = "# toolreader hook sha256 ";
const sha256 = (s: string) => NodeCrypto.createHash("sha256").update(s).digest("hex");
/** A hook script with its hash appended, as `hookFile` writes it. */
export const sealHook = (script: string) => `${script}${SEAL}${sha256(script)}\n`;
/** Whether a hook file is still exactly what `sealHook` wrote, whatever script that was. */
const isSealed = (text: string) => {
  const at = text.lastIndexOf(`\n${SEAL}`) + 1;
  return at > 0 && text === sealHook(text.slice(0, at));
};

const git = (repo: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
    spawner.string(ChildProcess.make("git", ["-C", repo, ...args])),
  ).pipe(
    Effect.map((s) => s.trim()),
    Effect.mapError((e) => new HistoryFailed({ message: e.message })),
  );

/**
 * Installs or removes one hook file. Each is written with a hash of its script, so a hook no one
 * edited is ours to replace even after the script changed (an upgrade, or toolreader moved), and
 * an edited one, or anyone else's, is left alone.
 */
export const hookFile = Effect.fn("historyHooks.hookFile")(
  function* (repo: string, name: string, script: string, action: "install" | "uninstall") {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.resolve(repo, yield* git(repo, ["rev-parse", "--git-path", `hooks/${name}`]));
    const current = (yield* fs.exists(file)) ? yield* fs.readFileString(file) : null;
    const ours = current !== null && current.includes(HOOK_MARKER) && isSealed(current);
    if (action === "uninstall") {
      if (current === null) return `No ${name} hook at ${file}.`;
      if (!ours)
        return yield* new HistoryFailed({
          message: `${file} is not toolreader's history hook as it wrote it; leaving it alone.`,
        });
      yield* fs.remove(file);
      return `Removed ${file}.`;
    }
    if (current !== null && !ours)
      return yield* new HistoryFailed({
        message: [
          `${file} already exists and is not toolreader's history hook; leaving it alone.`,
          `To chain it, run this from your hook${name === "pre-push" ? " with the push's stdin (a copy, if your hook reads it too)" : ', with "$@"'}:`,
          // A subshell, so its `exit 0`s end only this part.
          `(\n${script
            .split("\n")
            .filter((l) => !l.startsWith("#!"))
            .join("\n")}\n)`,
        ].join("\n"),
      });
    const sealed = sealHook(script);
    if (current === sealed) return `Already installed: ${file}.`;
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, sealed);
    yield* fs.chmod(file, 0o755);
    return `${current === null ? "Installed" : "Updated"} ${file}.`;
  },
  Effect.catchTag("PlatformError", (e) => Effect.fail(new HistoryFailed({ message: e.message }))),
);

/** Opts the repo in and installs its hooks, or opts it out and removes them. */
export const installHooks = Effect.fn("historyHooks.install")(function* (
  repo: string,
  action: "install" | "uninstall",
) {
  const self = selfCommand(yield* Path.Path);
  const out: string[] = [];
  // Off first: whatever happens to the files below, the hooks stop acting.
  if (action === "uninstall") {
    yield* git(repo, ["config", "--unset", OPT_IN_KEY]).pipe(Effect.ignore);
    out.push(`Unset ${OPT_IN_KEY}: hooks do nothing in this repo.`);
  }
  out.push(yield* hookFile(repo, "pre-push", prePushHook(self), action));
  // Without it, commits made by agents just get no trailer: a warning, not a failure.
  out.push(
    yield* hookFile(repo, "commit-msg", commitMsgHook(), action).pipe(
      Effect.catch((e) => Effect.succeed(`commit-msg: ${e.message}`)),
    ),
  );
  if (action === "install" && !(yield* hasSkill(repo)))
    out.push(
      "No agent skill here yet: `toolreader history skill install --commit` adds it, so agents declare their own history.",
    );
  if (action === "install") {
    yield* git(repo, ["config", OPT_IN_KEY, "true"]);
    out.push(`Set ${OPT_IN_KEY}=true: pushes to origin send their agent history.`);
  }
  return out;
});

const LOG_BYTES = 1024 * 1024;

/** Where hooks report; past LOG_BYTES it moves to `history.log.1` (one older file is kept). */
export const appendLog = Effect.fn("historyHooks.appendLog")(function* (
  title: string,
  lines: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { home } = yield* ServerConfig;
  const dir = path.join(home, ".toolreader");
  const log = path.join(dir, "history.log");
  const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
  yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 });
  yield* fs.stat(log).pipe(
    Effect.flatMap((s) => (Number(s.size) > LOG_BYTES ? fs.rename(log, `${log}.1`) : Effect.void)),
    Effect.ignore,
  );
  yield* fs.writeFileString(log, [`${at} ${title}`, ...lines.map((l) => `  ${l}`), ""].join("\n"), {
    flag: "a",
    mode: 0o600,
  });
  // `mode` applies only when the file is created: one an older hook made with the umask is fixed.
  yield* fs.chmod(log, 0o600).pipe(Effect.ignore);
});

/** A failure or crash, as one redacted line for the log. */
export const causeMessage = (cause: Cause.Cause<unknown>) => {
  const e = Cause.squash(cause);
  const message =
    typeof e === "object" && e !== null && "message" in e ? String(e.message) : String(e);
  return redactText(message).text;
};

const Pending = Schema.Struct({ repo: Schema.String, range: Schema.String });
const decodePending = Schema.decodeUnknownEffect(Schema.fromJsonString(Pending));
const encodePending = Schema.encodeEffect(Schema.fromJsonString(Pending));

/**
 * Ranges a hook couldn't sync (the backend down), each its own file in ~/.toolreader/pending/, for
 * the next hook in the same repository: `repo` is its common git directory, so any worktree of it
 * retries. One file per range, written whole and renamed into place: hooks finishing at once never
 * overwrite each other's.
 */
export const pending = (repo: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { home } = yield* ServerConfig;
    const dir = path.join(home, ".toolreader", "pending");
    const file = (range: string) =>
      path.join(dir, `${sha256(`${repo}\n${range}`).slice(0, 32)}.json`);
    const list = fs.readDirectory(dir).pipe(
      Effect.flatMap((names) =>
        Effect.forEach(
          names.filter((n) => n.endsWith(".json")),
          (n) =>
            fs.readFileString(path.join(dir, n)).pipe(Effect.flatMap(decodePending), Effect.option),
        ),
      ),
      Effect.map((found) =>
        found.flatMap((p) => (p._tag === "Some" && p.value.repo === repo ? [p.value.range] : [])),
      ),
      Effect.orElseSucceed(() => [] as string[]),
    );
    const add = (range: string) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 });
        const tmp = `${file(range)}.${NodeCrypto.randomUUID()}.tmp`;
        yield* fs.writeFileString(tmp, yield* encodePending({ repo, range }), { mode: 0o600 });
        yield* fs.rename(tmp, file(range));
      }).pipe(Effect.ignore);
    const done = (range: string) => fs.remove(file(range)).pipe(Effect.ignore);
    return { list, add, done };
  });
