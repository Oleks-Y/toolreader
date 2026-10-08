// The commit ledger: one entry per code commit an agent made, holding the slice of session history
// that produced it. Entries live on a separate `agent-ledger` branch as `commits/<sha>.json`, so a
// repo alone can show "what the agent did for each commit". Pure, so server and browser share it.
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { Entry, Labels, ThreadSource, type Action } from "./domain.ts";
import { redactEntries, redactLabels, redactor } from "./proof.ts";
import { humanizeCommand, unwrapShell } from "./shell.ts";
import { splitTurns } from "./tree.ts";

export const LEDGER_FORMAT_VERSION = 2;
export const LEDGER_BRANCH = "agent-ledger";

export const LedgerCommit = Schema.Struct({
  sha: Schema.String,
  subject: Schema.String,
  committedAt: Schema.String,
  /** `git patch-id --stable`: survives rebases and amends that keep the diff. */
  patchId: Schema.NullOr(Schema.String),
});
export type LedgerCommit = typeof LedgerCommit.Type;

const ThreadFields = {
  id: Schema.String,
  title: Schema.String,
  source: ThreadSource,
  provider: Schema.NullOr(Schema.String),
  origin: Schema.NullOr(Schema.String),
};

export const LedgerThread = Schema.Struct({
  ...ThreadFields,
  /** The thread that delegated this one, for a subagent. */
  parent: Schema.NullOr(Schema.String),
});
export type LedgerThread = typeof LedgerThread.Type;

export const LINK_ROLES = ["coder", "reviewer", "committer"] as const;
export type LinkRole = (typeof LINK_ROLES)[number];
/**
 * How a thread was tied to a commit, strongest first: a person said so (`ledger link`/`review`),
 * an `Agent-Session` trailer, its SHA in `git commit` output, `sync --session`, the time of a
 * `git commit` action, or edits to the commit's files.
 */
export const LINK_VIA = ["asserted", "trailer", "sha", "session", "time", "evidence"] as const;
export type LinkVia = (typeof LINK_VIA)[number];

export const LedgerLink = Schema.Struct({
  thread: LedgerThread,
  role: Schema.Literals(LINK_ROLES),
  via: Schema.Literals(LINK_VIA),
  /** For a reviewer: the commit it reviewed. On any other SHA the review is stale. */
  reviewedSha: Schema.NullOr(Schema.String),
  /** The commit's files this thread edited. */
  files: Schema.Array(Schema.String),
  /** History since the thread's previous commit (or its start), up to this commit; empty until sync finds it. */
  entries: Schema.Array(Entry),
  labels: Labels,
});
export type LedgerLink = typeof LedgerLink.Type;

/** Each file of the commit, once: edited by one linked thread, by several, or by none. */
export const FILE_BUCKETS = ["attributed", "shared", "untracked"] as const;
export const FileCoverage = Schema.Struct({
  path: Schema.String,
  bucket: Schema.Literals(FILE_BUCKETS),
});
export type FileCoverage = typeof FileCoverage.Type;

export const LedgerNote = Schema.Struct({
  text: Schema.String,
  /** A file of the commit, or null for the commit as a whole. */
  file: Schema.NullOr(Schema.String),
  at: Schema.String,
});
export type LedgerNote = typeof LedgerNote.Type;

const LedgerEntryV2 = Schema.Struct({
  formatVersion: Schema.Literal(LEDGER_FORMAT_VERSION),
  commit: LedgerCommit,
  links: Schema.Array(LedgerLink),
  /** Threads `ledger unlink` removed: sync and merges never add them back; `link` does. */
  unlinked: Schema.Array(Schema.String),
  files: Schema.Array(FileCoverage),
  notes: Schema.Array(LedgerNote),
  outputs: Schema.Literals(["included", "omitted"]),
  redactions: Schema.Number,
});

/** Entries written before several threads per commit: one thread, its match, its history. */
const LedgerEntryV1 = Schema.Struct({
  formatVersion: Schema.Literal(1),
  commit: LedgerCommit,
  thread: Schema.Struct(ThreadFields),
  match: Schema.Literals(["sha", "time", "session"]),
  outputs: Schema.Literals(["included", "omitted"]),
  redactions: Schema.Number,
  entries: Schema.Array(Entry),
  labels: Labels,
});

/** A v1 entry reads as one coder link; the branch is never rewritten for it. */
const fromV1 = LedgerEntryV1.pipe(
  Schema.decodeTo(
    LedgerEntryV2,
    SchemaTransformation.transform({
      decode: (v1): typeof LedgerEntryV2.Encoded => ({
        formatVersion: LEDGER_FORMAT_VERSION,
        commit: v1.commit,
        links: [
          {
            thread: { ...v1.thread, parent: null },
            role: "coder" as const,
            via: v1.match,
            reviewedSha: null,
            files: [],
            entries: v1.entries,
            labels: v1.labels,
          },
        ],
        unlinked: [],
        files: [],
        notes: [],
        outputs: v1.outputs,
        redactions: v1.redactions,
      }),
      // Never used: encoding picks the v2 member first.
      encode: (v2): typeof LedgerEntryV1.Type => {
        const link = v2.links[0];
        return {
          formatVersion: 1 as const,
          commit: v2.commit,
          thread: link?.thread ?? {
            id: "",
            title: "",
            source: "t3" as const,
            provider: null,
            origin: null,
          },
          match: link?.via === "sha" || link?.via === "time" ? link.via : ("session" as const),
          outputs: v2.outputs,
          redactions: v2.redactions,
          entries: link?.entries ?? [],
          labels: link?.labels ?? {},
        };
      },
    }),
  ),
);

export const LedgerEntry = Schema.Union([LedgerEntryV2, fromV1]);
export type LedgerEntry = typeof LedgerEntryV2.Type;

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

/** A thread found for a commit, before redaction. */
export type FoundLink = {
  readonly thread: LedgerThread;
  readonly role: LinkRole;
  readonly via: LinkVia;
  readonly reviewedSha: string | null;
  readonly segment: ReadonlyArray<Entry>;
  readonly labels: Labels;
  /** The worktree the thread worked in: absolute paths outside it are not the commit's. */
  readonly root?: string | null;
};

/**
 * The entry for `commit`: each link's segment, the commit subject, thread titles, labels and
 * notes redacted like every other free-text field (a title is the first prompt line), and outputs
 * clipped. Labels are kept for the segment's entries and fold groups. `paths` are the files the
 * commit changed.
 */
export function buildEntry(input: {
  readonly commit: LedgerCommit;
  readonly links: ReadonlyArray<FoundLink>;
  readonly paths: ReadonlyArray<string>;
  readonly notes?: ReadonlyArray<LedgerNote>;
  readonly outputs: boolean;
  readonly maxOutput: number;
  readonly home?: string | undefined;
}): LedgerEntry {
  const { clean, count } = redactor(input.home);
  let redactions = 0;
  const links = input.links.map((found): LedgerLink => {
    const redacted = redactEntries(found.segment, { outputs: input.outputs, home: input.home });
    redactions += redacted.redactions;
    const entries = clipOutputs(redacted.entries, input.maxOutput);
    const ids = new Set(entries.map((e) => e.id));
    return {
      thread: { ...found.thread, title: clean(found.thread.title) },
      role: found.role,
      via: found.via,
      reviewedSha: found.reviewedSha,
      // A review comes after the commit: what it edits is not the commit's.
      files:
        found.role === "reviewer" ? [] : [...editedPaths(found.segment, input.paths, found.root)],
      entries,
      labels: redactLabels(
        Object.fromEntries(
          Object.entries(found.labels).filter(([id]) => ids.has(id) || id.startsWith("fold:")),
        ),
        clean,
      ),
    };
  });
  const notes = (input.notes ?? []).map((n) => ({ ...n, text: clean(n.text) }));
  return {
    formatVersion: LEDGER_FORMAT_VERSION,
    commit: { ...input.commit, subject: clean(input.commit.subject) },
    links,
    unlinked: [],
    files: fileCoverage(input.paths, links),
    notes,
    outputs: input.outputs ? "included" : "omitted",
    redactions: redactions + count(),
  };
}

const STRENGTH: Record<LinkVia, number> = Object.fromEntries(
  LINK_VIA.map((via, i) => [via, LINK_VIA.length - i]),
) as Record<LinkVia, number>;
export const strongerVia = (a: LinkVia, b: LinkVia) => STRENGTH[a] > STRENGTH[b];

const linkKey = (l: LedgerLink) => `${l.thread.id}\u0000${l.role}`;

/**
 * `found` added to `current`, one link per thread and role (a coder can review its own commit):
 * the stronger `via` wins (at equal strength the found one, unless asserted), and a link with no
 * history yet takes the other's. `explicit` (what
 * `ledger link`/`review` just asserted) replaces its link outright. Nothing is dropped.
 */
export function mergeLinks(
  current: ReadonlyArray<LedgerLink>,
  found: ReadonlyArray<LedgerLink>,
  explicit = false,
): LedgerLink[] {
  const out = new Map(current.map((l) => [linkKey(l), l]));
  for (const link of found) {
    const old = out.get(linkKey(link));
    if (!old || (explicit && link.via === "asserted")) {
      out.set(linkKey(link), link);
      continue;
    }
    // Sync's own finding at the same strength is newer: it may hold history the old one lacks.
    const newer = link.via !== "asserted" && !strongerVia(old.via, link.via);
    const [keep, other] = newer ? [link, old] : [old, link];
    out.set(
      linkKey(link),
      keep.entries.length > 0
        ? keep
        : { ...keep, entries: other.entries, labels: other.labels, files: other.files },
    );
  }
  return [...out.values()];
}

/**
 * `fresh` merged into `current` (same commit): links merged, notes added, files recounted. A
 * thread either side unlinked stays out; only `relink` (what `ledger link` just named) brings it
 * back, so an older copy of a link never undoes a later unlink.
 */
export function mergeEntries(
  current: LedgerEntry,
  fresh: LedgerEntry,
  relink: ReadonlyArray<string> = [],
): LedgerEntry {
  const unlinked = [...new Set([...current.unlinked, ...fresh.unlinked])].filter(
    (id) => !relink.includes(id),
  );
  const out = new Set(unlinked);
  const links = mergeLinks(current.links, fresh.links, relink.length > 0).filter(
    (l) => !out.has(l.thread.id),
  );
  // An entry read from format 1 has links but no file list: its coverage stays unknown.
  const paths = current.files.length > 0 || current.links.length > 0 ? current.files : fresh.files;
  const seen = new Set(current.notes.map((n) => JSON.stringify(n)));
  const added = fresh.notes.filter((n) => !seen.has(JSON.stringify(n)));
  const changed = added.length > 0 || JSON.stringify(links) !== JSON.stringify(current.links);
  return {
    ...current,
    formatVersion: LEDGER_FORMAT_VERSION,
    links,
    unlinked,
    files: fileCoverage(
      paths.map((f) => f.path),
      links,
    ),
    notes: [...current.notes, ...added],
    redactions: current.redactions + (changed ? fresh.redactions : 0),
  };
}

/** Each of `paths` once, by how many links edited it. */
export function fileCoverage(
  paths: ReadonlyArray<string>,
  links: ReadonlyArray<Pick<LedgerLink, "files">>,
): FileCoverage[] {
  return paths.map((path) => {
    const n = links.filter((l) => l.files.includes(path)).length;
    return { path, bucket: n === 0 ? "untracked" : n === 1 ? "attributed" : "shared" };
  });
}

/** A reviewer link counts only on the commit it reviewed. */
export const isStale = (link: LedgerLink, sha: string) =>
  link.role === "reviewer" && !!link.reviewedSha && link.reviewedSha !== sha;

/**
 * The commit `paths` (repo-relative) that `entries` wrote: edit tools' files, and shell commands
 * that write (`>`, heredoc, `sed -i`, `cp`, `mv`, `rm`). Reads and `git add` don't count.
 */
export function editedPaths(
  entries: ReadonlyArray<Entry>,
  paths: ReadonlyArray<string>,
  root: string | null = null,
): Set<string> {
  // ponytail: tool paths are absolute or relative to an unknown cwd, so a path matches by
  // whole trailing segments, the longest commit path winning; a relative path written from a
  // subdirectory can still name the wrong one of two same-named files.
  const sameFile = (written: string, path: string) => {
    let w = written.replace(/^\.\//, "");
    // An absolute path counts only inside the session's worktree (never /tmp, another checkout).
    if (w.startsWith("/") && root) {
      if (!w.startsWith(`${root}/`)) return false;
      w = w.slice(root.length + 1);
    }
    return w === path || w.endsWith(`/${path}`) || path.endsWith(`/${w}`);
  };
  const hit = new Set<string>();
  for (const e of entries) {
    if (e.type !== "action" || e.status === "failed") continue;
    const written = [
      ...(e.files ?? []).map((f) => f.path),
      ...(e.command
        ? humanizeCommand(e.command).flatMap((p) => (p.kind === "edit" ? (p.targets ?? []) : []))
        : []),
    ];
    for (const w of written) {
      const best = paths.filter((p) => sameFile(w, p)).sort((x, y) => y.length - x.length)[0];
      if (best) hit.add(best);
    }
  }
  return hit;
}

/**
 * History `from`..`to` (ISO times, `from` exclusive), for a thread tied by trailer or evidence
 * rather than by its own `git commit` action.
 */
export function segmentByTime(
  entries: ReadonlyArray<Entry>,
  from: string | null,
  to: string,
): Entry[] {
  const since = from ? Date.parse(from) : -Infinity;
  const until = Date.parse(to) + CLOCK_SKEW_MS;
  const start = entries.findIndex((e) => Date.parse(e.at) > since);
  if (start < 0) return [];
  const end = entries.findIndex((e, i) => i >= start && Date.parse(e.at) > until);
  return segmentBetween(entries, start, end < 0 ? entries.length : end);
}

/** Trailer that names the agent session a commit came from (`ledger stamp`, the commit hook). */
export const SESSION_TRAILER = "Agent-Session";

/**
 * The agent session this process runs in, from the variables agents export to their commands
 * (`codex:<id>`, `claude-code:<id>`), or null outside an agent.
 */
export function sessionFromEnv(env: Readonly<Record<string, string | undefined>>): string | null {
  if (env.CODEX_THREAD_ID) return `codex:${env.CODEX_THREAD_ID}`;
  if (env.CLAUDE_CODE_SESSION_ID) return `claude-code:${env.CLAUDE_CODE_SESSION_ID}`;
  return null;
}

/** The provider's own session id of a session name: `codex:<id>` / `claude-code:<id>` → `<id>`. */
export const nativeId = (session: string) => session.replace(/^(?:codex|claude-code):/, "");

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

/**
 * The `commit-msg` hook (`ledger hook install --commit`): a commit made inside an agent session
 * gets an `Agent-Session` trailer naming it, once. It runs on the final message, after any editor.
 * Plain shell, so it adds no Node start to a commit; outside an agent it does nothing, and it
 * never stops a commit.
 */
export function commitMsgHook(): string {
  return `#!/bin/sh
${HOOK_MARKER}: names the agent session a commit comes from, for ${LEDGER_BRANCH}.
# Remove it with \`ledger hook uninstall\`. It never stops a commit.
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
