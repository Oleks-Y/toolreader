// The commit ledger: one entry per code commit an agent made, holding the slice of session history
// that produced it. Entries live on a separate `agent-ledger` branch as `commits/<sha>.json`, so a
// repo alone can show "what the agent did for each commit". Pure, so server and browser share it.
import * as Schema from "effect/Schema";

import { Entry, Labels, ThreadSource, type Action } from "./domain.ts";
import { redactEntries, redactLabels, redactor } from "./proof.ts";
import { unwrapShell } from "./shell.ts";
import { splitTurns } from "./tree.ts";

export const LEDGER_FORMAT_VERSION = 1;
export const LEDGER_BRANCH = "agent-ledger";

export const LedgerCommit = Schema.Struct({
  sha: Schema.String,
  subject: Schema.String,
  committedAt: Schema.String,
  /** `git patch-id --stable`: survives rebases and amends that keep the diff. */
  patchId: Schema.NullOr(Schema.String),
});
export type LedgerCommit = typeof LedgerCommit.Type;

export const LedgerEntry = Schema.Struct({
  formatVersion: Schema.Literal(LEDGER_FORMAT_VERSION),
  commit: LedgerCommit,
  thread: Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    source: ThreadSource,
    provider: Schema.NullOr(Schema.String),
    origin: Schema.NullOr(Schema.String),
  }),
  /**
   * How the commit was tied to the session: its SHA in `git commit` output, the time of a
   * `git commit` action, or (no commit action anywhere) a session that ended before the commit.
   */
  match: Schema.Literals(["sha", "time", "session"]),
  outputs: Schema.Literals(["included", "omitted"]),
  redactions: Schema.Number,
  /** History since the agent's previous commit in that thread (or the thread start), up to this commit. */
  entries: Schema.Array(Entry),
  labels: Labels,
});
export type LedgerEntry = typeof LedgerEntry.Type;

/** One commit of a range, with its ledger entry when the ledger has one. */
export const LedgerCommitView = Schema.Struct({
  commit: LedgerCommit,
  entry: Schema.NullOr(LedgerEntry),
  /** The entry was found by patch-id because the SHA changed (rebase/amend). */
  matchedBy: Schema.NullOr(Schema.Literals(["sha", "patch-id"])),
});
export type LedgerCommitView = typeof LedgerCommitView.Type;

export type CommitAction = {
  readonly index: number;
  readonly action: Action;
  /** Short or full SHAs the output printed (`[branch abc1234] subject`), one per commit made. */
  readonly shas: ReadonlyArray<string>;
};

// `git` in command position (start, or after `&&`, `;`, `|`, `(`, a newline, env assignments), so
// heredocs, greps and messages that merely mention "git commit" don't count.
const GIT_COMMIT = /(?:^|[;&|(\n])\s*(?:\w+=\S*\s+)*git(?:\s+-[cC]\s+\S+)*\s+commit\b/;
const COMMIT_SUMMARY = /^\[[^\]\s]+(?: \([^)]*\))? ([0-9a-f]{7,40})\]/gm;

/** `git commit` actions in time order, with the SHAs the output shows. */
export function findCommitActions(entries: ReadonlyArray<Entry>): CommitAction[] {
  const out: CommitAction[] = [];
  entries.forEach((e, index) => {
    // Codex wraps commands in `/bin/zsh -lc "…"`; the script inside is what runs.
    if (
      e.type !== "action" ||
      e.status === "failed" ||
      !GIT_COMMIT.test(unwrapShell(e.command ?? e.title))
    )
      return;
    const shas = [...(e.output ?? "").matchAll(COMMIT_SUMMARY)].map((m) => m[1]!);
    out.push({ index, action: e, shas });
  });
  return out;
}

/** Max delay between a `git commit` action starting and git recording the commit (hooks, checks). */
const MAX_COMMIT_DELAY_MS = 10 * 60_000;
const CLOCK_SKEW_MS = 2_000;

/**
 * The commit action that produced `commit`: a printed SHA wins; otherwise the latest commit action
 * that started shortly before the commit time.
 */
export function matchCommit(
  commit: LedgerCommit,
  actions: ReadonlyArray<CommitAction>,
): { action: CommitAction; match: "sha" | "time" } | null {
  const bySha = actions.find((a) => a.shas.some((sha) => commit.sha.startsWith(sha)));
  if (bySha) return { action: bySha, match: "sha" };
  const at = Date.parse(commit.committedAt);
  let best: CommitAction | null = null;
  for (const a of actions) {
    if (a.shas.length > 0) continue; // printed other SHAs: not this commit
    const started = Date.parse(a.action.at);
    if (started > at + CLOCK_SKEW_MS || at - started > MAX_COMMIT_DELAY_MS) continue;
    if (!best || started > Date.parse(best.action.at)) best = a;
  }
  return best ? { action: best, match: "time" } : null;
}

/**
 * History that produced a commit: everything after the previous commit action in the same thread
 * (or from the thread start) up to and including this commit action.
 */
export function segmentFor(
  entries: ReadonlyArray<Entry>,
  commitAction: CommitAction,
  allCommitActions: ReadonlyArray<CommitAction>,
): Entry[] {
  const previous = allCommitActions.findLast((a) => a.index < commitAction.index);
  return segmentBetween(entries, previous ? previous.index + 1 : 0, commitAction.index + 1);
}

/**
 * Sessions that ended between the previous commit and this one: candidates for a commit no
 * `git commit` action made (an agent edits, a later step commits: CI, where the sandbox blocks
 * `.git`). The caller decides which sessions may count, and attaches none when several do.
 */
export function sessionsBetween<S extends { readonly entries: ReadonlyArray<Entry> }>(
  commit: LedgerCommit,
  previousAt: string | null,
  sessions: ReadonlyArray<S>,
): S[] {
  const at = Date.parse(commit.committedAt);
  const after = previousAt ? Date.parse(previousAt) : -Infinity;
  return sessions.filter((session) => {
    const lastAt = session.entries.at(-1)?.at;
    const last = lastAt ? Date.parse(lastAt) : NaN;
    return last > after && last <= at + CLOCK_SKEW_MS;
  });
}

/** The session changed files: an edit, or a shell command that writes one (`>`, heredoc, `sed -i`). */
export const madeEdits = (entries: ReadonlyArray<Entry>) =>
  entries.some(
    (e) =>
      e.type === "action" &&
      e.status !== "failed" &&
      (e.kind === "edit" || !!e.files?.length || !!e.parts?.some((p) => p.kind === "edit")),
  );

/** The part of a session tied to a commit by `sessionsBetween` to a commit: after its last commit action and the previous commit. */
export function sessionSegment(
  entries: ReadonlyArray<Entry>,
  commitActions: ReadonlyArray<CommitAction>,
  previousAt: string | null,
): Entry[] {
  const afterCommit = (commitActions.at(-1)?.index ?? -1) + 1;
  const since = previousAt ? Date.parse(previousAt) : -Infinity;
  const afterPrevious = entries.findIndex((e) => Date.parse(e.at) > since);
  const from = Math.max(afterCommit, afterPrevious < 0 ? entries.length : afterPrevious);
  return segmentBetween(entries, from, entries.length);
}

/**
 * Entries `from`..`to` (exclusive). Leading turns with no actions (pure discussion) are dropped,
 * and a segment that starts mid-turn gets that turn's prompt back.
 */
function segmentBetween(entries: ReadonlyArray<Entry>, from: number, to: number): Entry[] {
  const turns = splitTurns(entries.slice(from, to));
  const firstWithActions = turns.findIndex((t) => t.entries.some((e) => e.type === "action"));
  const kept = turns.slice(Math.max(firstWithActions, 0));
  const out = kept.flatMap((t) => (t.prompt ? [t.prompt, ...t.entries] : [...t.entries]));
  if (kept[0] && !kept[0].prompt) {
    const prompt = entries
      .slice(0, from)
      .findLast((e) => e.type === "message" && e.role === "user");
    if (prompt) out.unshift(prompt);
  }
  return out;
}

export const ledgerPath = (sha: string) => `commits/${sha}.json`;

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();
const isContinuation = (b: number | undefined) => b !== undefined && (b & 0xc0) === 0x80;

/**
 * Keeps the head and tail of each action output, `maxBytes` (UTF-8) in total, with a marker where
 * the middle was cut; `clipped` records the bytes left out. 0 keeps outputs whole.
 */
export function clipOutputs(entries: ReadonlyArray<Entry>, maxBytes: number): Entry[] {
  return entries.map((e) => {
    if (maxBytes <= 0 || e.type !== "action" || !e.output) return e;
    const bytes = utf8.encode(e.output);
    if (bytes.length <= maxBytes) return e;
    // Cut on character boundaries, never inside a multi-byte sequence.
    let head = Math.floor(maxBytes / 2);
    while (head > 0 && isContinuation(bytes[head])) head--;
    let tail = bytes.length - (maxBytes - head);
    while (tail < bytes.length && isContinuation(bytes[tail])) tail++;
    const clipped = tail - head;
    const output = `${fromUtf8.decode(bytes.subarray(0, head))}\n… [${clipped} bytes clipped] …\n${fromUtf8.decode(bytes.subarray(tail))}`;
    return { ...e, output, clipped };
  });
}

/**
 * The entry for `commit`: the segment's entries, the thread's title and the labels redacted like
 * every other free-text field (the title is the first prompt line), and outputs clipped. Labels
 * are kept for the segment's entries and fold groups.
 */
export function buildEntry(input: {
  readonly commit: LedgerCommit;
  readonly thread: LedgerEntry["thread"];
  readonly match: LedgerEntry["match"];
  readonly segment: ReadonlyArray<Entry>;
  readonly labels: Labels;
  readonly outputs: boolean;
  readonly maxOutput: number;
  readonly home?: string | undefined;
}): LedgerEntry {
  const redacted = redactEntries(input.segment, { outputs: input.outputs, home: input.home });
  const entries = clipOutputs(redacted.entries, input.maxOutput);
  const ids = new Set(entries.map((e) => e.id));
  const { clean, count } = redactor(input.home);
  const thread = { ...input.thread, title: clean(input.thread.title) };
  const labels = redactLabels(
    Object.fromEntries(
      Object.entries(input.labels).filter(([id]) => ids.has(id) || id.startsWith("fold:")),
    ),
    clean,
  );
  return {
    formatVersion: LEDGER_FORMAT_VERSION,
    commit: input.commit,
    thread,
    match: input.match,
    outputs: input.outputs ? "included" : "omitted",
    redactions: redacted.redactions + count(),
    entries,
    labels,
  };
}

/** First line of the hook `ledger hook install` writes; marks the file as ours. */
export const HOOK_MARKER = "# toolreader ledger hook";

/**
 * The `pre-push` hook: for each branch pushed to origin, syncs the pushed commits with `--push`.
 * It reads every pushed ref first: when the push carries agent-ledger itself, a nested push of it
 * would make git reject that ref (and an `--atomic` push whole), so it only records locally then.
 * Ledger trouble only warns; the user's push always goes on.
 */
export function prePushHook(command: string): string {
  return `#!/bin/sh
${HOOK_MARKER}: records agent history for pushed commits on ${LEDGER_BRANCH}.
# Remove it with \`ledger hook uninstall\`. It never stops a push.
[ "$1" = origin ] || exit 0
repo=$(git rev-parse --show-toplevel) || exit 0
refs=$(cat)
push=--push
while read -r local_ref local_sha remote_ref remote_sha; do
  [ "$remote_ref" = refs/heads/${LEDGER_BRANCH} ] && push=
done <<EOF
$refs
EOF
[ -n "$push" ] ||
  echo "toolreader: this push carries ${LEDGER_BRANCH}; new entries stay local until the next push" >&2
while read -r local_ref local_sha remote_ref remote_sha; do
  [ -n "$local_sha" ] || continue
  case "$remote_ref" in refs/heads/${LEDGER_BRANCH}) continue ;; esac
  case "$local_sha" in *[!0]*) ;; *) continue ;; esac
  case "$remote_sha" in
    *[!0]*) range="$remote_sha..$local_sha" ;;
    *) range="$local_sha --not --remotes=origin" ;;
  esac
  ${command} sync --repo "$repo" --range "$range" $push </dev/null ||
    echo "toolreader: ledger sync failed; pushing anyway" >&2
done <<EOF
$refs
EOF
exit 0
`;
}

/** A commit range as the viewer shows it: each commit with its agent history, if any. */
export const LedgerRange = Schema.Struct({
  repo: Schema.String,
  range: Schema.String,
  /** Web URL of the origin remote (credentials removed), for commit links. */
  remoteUrl: Schema.NullOr(Schema.String),
  commits: Schema.Array(LedgerCommitView),
});
export type LedgerRange = typeof LedgerRange.Type;

/** `git@github.com:o/r.git` / `https://host/o/r.git` → `https://host/o/r`, for linking commits. */
export function remoteWebUrl(remote: string | null): string | null {
  if (!remote) return null;
  const ssh = /^[\w.-]+@([\w.-]+):(.+?)(?:\.git)?$/.exec(remote);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  const http = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(remote);
  return http ? `https://${http[1]}/${http[2]}` : null;
}
