// The commit ledger: one entry per code commit an agent made, holding the slice of session history
// that produced it. Entries live on a separate `agent-ledger` branch as `commits/<sha>.json`, so a
// repo alone can show "what the agent did for each commit". Pure, so server and browser share it.
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { Entry, Labels, ThreadSource } from "./domain.ts";
import { redactEntries, redactLabels, redactor } from "./proof.ts";
import { humanizeCommand } from "./shell.ts";

export const LEDGER_FORMAT_VERSION = 2;
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
export const LINK_VIA = [
  "asserted",
  "trailer",
  "sha",
  "session",
  "time",
  "evidence",
  "content",
] as const;
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
  /** The repo's worktrees: absolute paths outside them are not the commit's. */
  readonly roots?: ReadonlyArray<string> | undefined;
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
        found.role === "reviewer"
          ? []
          : [...editedPaths(found.segment, input.paths, { roots: input.roots, home: input.home })],
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
  where: {
    readonly roots?: ReadonlyArray<string> | undefined;
    readonly home?: string | undefined;
  } = {},
): Set<string> {
  const roots = [...(where.roots ?? [])].sort((x, y) => y.length - x.length);
  // Entries write paths outside the thread's own worktree as `~/…` (normalize); those and absolute
  // paths count only inside a worktree of this repo, compared exactly (never /tmp, another repo).
  // ponytail: a relative path's cwd is unknown, so it matches by whole trailing segments, the
  // longest commit path winning; written from a subdirectory it can name the wrong one of two
  // same-named files.
  const sameFile = (written: string, path: string) => {
    let w = written.replace(/^\.\//, "");
    if (where.home && (w === "~" || w.startsWith("~/"))) w = `${where.home}${w.slice(1)}`;
    if (w.startsWith("/") || w.startsWith("~")) {
      const root = roots.find((r) => w.startsWith(`${r}/`));
      return !!root && w.slice(root.length + 1) === path;
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

/** Trailer that names the agent session a commit came from (`ledger stamp`, the commit hook). */
export const SESSION_TRAILER = "Agent-Session";

/** The provider's own session id of a session name: `codex:<id>` / `claude-code:<id>` → `<id>`. */
export const nativeId = (session: string) => session.replace(/^(?:codex|claude-code):/, "");

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
  const sshUrl = /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(remote);
  if (sshUrl) return `https://${sshUrl[1]}/${sshUrl[2]}`;
  const http = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(remote);
  return http ? `https://${http[1]}/${http[2]}` : null;
}
