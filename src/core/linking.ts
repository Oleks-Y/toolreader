// Which sessions belong to which commit. `linkCommits` is the matching `ledger sync` does (trailer →
// printed SHA → time → `--session`/`--match-sessions` → edit evidence); `selectScope` turns a
// range's links into exactly what checkpoints take, plus the sessions that only show weaker signals
// (shell-only agents: scripts, patches, `git add`), for a person to decide. Nothing
// outside a commit's links is ever taken. Pure: the server loads commits and sessions.
import type { Entry, Labels } from "./domain.ts";
import {
  commitPathMatcher,
  editedPaths,
  matchCommit,
  segmentByTime,
  segmentFor,
  sessionSegment,
  sessionsBetween,
  type CommitAction,
  type FoundLink,
  type LedgerCommit,
  type LedgerThread,
  type LinkVia,
  type PathWhere,
} from "./ledger.ts";
import { splitCommand, unwrapShell } from "./shell.ts";
import { splitTurns } from "./tree.ts";

/** A commit of the range, with what git says about it. */
export type LinkCommit = {
  readonly commit: LedgerCommit;
  /** The first parent's commit time; null for a root commit. */
  readonly previousAt: string | null;
  /** `Agent-Session` trailer values. */
  readonly trailers: ReadonlyArray<string>;
  /** Files it changed against its first parent; empty for a merge. */
  readonly paths: ReadonlyArray<string>;
};

/** A session that worked in one of the repo's worktrees, loaded once. */
export type LinkSession = {
  /** Worked in the worktree being synced, not another worktree of the repo. */
  readonly here: boolean;
  readonly edited: boolean;
  readonly entries: ReadonlyArray<Entry>;
  readonly actions: ReadonlyArray<CommitAction>;
  readonly labels: Labels;
  readonly thread: LedgerThread;
};

export type LinkOptions<S extends LinkSession> = PathWhere & {
  /** The sessions a name means (thread id, `codex:<id>`, `claude-code:<id>`, a provider id). */
  readonly named: (name: string) => ReadonlyArray<S>;
  /** `--session`: who takes a commit no `git commit` action made. */
  readonly sessions: ReadonlyArray<string>;
  /** `--match-sessions`: else the one session here that edited and ended in the window. */
  readonly matchSessions: boolean;
  /**
   * `--history-since`: for stacked PRs split from one long-lived branch, whose commits came long
   * after the work. A commit's history is then each turn since this time, in any worktree, that
   * edited one of its files (`trees`: each commit's files, for files moved since); who ran
   * `git commit` (sha, time, `--session`) is bookkeeping there and isn't matched.
   */
  readonly historySince?: string | undefined;
  readonly trees?: ReadonlyMap<string, ReadonlySet<string>> | undefined;
};

/** The turns of `entries` in `from`..`to` that edited one of `paths`, each with its prompt. */
export function editingTurns(
  entries: ReadonlyArray<Entry>,
  paths: ReadonlyArray<string>,
  where: PathWhere,
  from: string,
  to: string,
): Entry[] {
  return splitTurns(segmentByTime(entries, from, to)).flatMap((t) =>
    editedPaths(t.entries, paths, where).size > 0
      ? [...(t.prompt ? [t.prompt] : []), ...t.entries]
      : [],
  );
}

export type CommitLinks = {
  readonly commit: LinkCommit;
  /** Strongest first, one per thread. */
  readonly links: ReadonlyArray<FoundLink>;
  /** Several sessions could have made it and none was attached: their thread ids. */
  readonly ambiguous: ReadonlyArray<string> | null;
};

/** Each commit's links, exactly as `ledger sync` finds them. */
export function linkCommits<S extends LinkSession>(
  commits: ReadonlyArray<LinkCommit>,
  sessions: ReadonlyArray<S>,
  options: LinkOptions<S>,
): CommitLinks[] {
  const where = { roots: options.roots, home: options.home };
  const eligible =
    options.sessions.length > 0
      ? [...new Set(options.sessions.flatMap(options.named))]
      : options.matchSessions
        ? sessions.filter((s) => s.here && s.edited)
        : [];
  return commits.map((c) => {
    const { commit, previousAt: before, paths } = c;
    const found: FoundLink[] = [];
    // Strongest first; a thread found again keeps its first (strongest) link.
    const add = (s: S, via: LinkVia, segment: ReadonlyArray<Entry>) => {
      // A trailer names the thread even when its history here shows no action.
      if (via !== "trailer" && !segment.some((e) => e.type === "action")) return;
      if (found.some((f) => f.thread.id === s.thread.id)) return;
      found.push({
        thread: s.thread,
        role: "coder",
        via,
        reviewedSha: null,
        segment,
        labels: s.labels,
      });
    };
    // A trailer's thread: everything since the commit's parent (an amend or an earlier
    // `git commit` of the same change must not cut its history short).
    for (const name of c.trailers)
      for (const s of options.named(name))
        add(s, "trailer", segmentByTime(s.entries, before, commit.committedAt));
    if (options.historySince !== undefined) {
      const at = { ...where, tree: options.trees?.get(commit.sha) };
      for (const s of sessions)
        add(
          s,
          "evidence",
          editingTurns(s.entries, paths, at, options.historySince, commit.committedAt),
        );
      return { commit: c, links: found, ambiguous: null };
    }
    // A printed SHA, in any session; else the latest `git commit` action just before it.
    const candidates = sessions.flatMap((s) => {
      const m = matchCommit(commit, s.actions);
      return m ? [{ session: s, ...m }] : [];
    });
    for (const m of candidates.filter((m) => m.match === "sha"))
      add(m.session, "sha", segmentFor(m.session.entries, m.action, m.session.actions));
    const byTime = candidates
      .filter((m) => m.match === "time")
      .sort((a, b) => (a.action.action.at < b.action.action.at ? 1 : -1))[0];
    if (byTime && found.length === 0)
      add(
        byTime.session,
        "time",
        segmentFor(byTime.session.entries, byTime.action, byTime.session.actions),
      );
    if (found.length === 0 && eligible.length > 0) {
      const between = sessionsBetween(commit, before, eligible);
      if (between.length > 1)
        return { commit: c, links: [], ambiguous: between.map((s) => s.thread.id) };
      const s = between[0];
      if (s) add(s, "session", sessionSegment(s.entries, s.actions, before));
    }
    // Every other thread that edited the commit's files in this worktree since the previous
    // commit (another worktree's edits never reach this commit).
    for (const s of sessions.filter((s) => s.here)) {
      const segment = segmentByTime(s.entries, before, commit.committedAt);
      if (editedPaths(segment, paths, where).size > 0) add(s, "evidence", segment);
    }
    return { commit: c, links: found, ambiguous: null };
  });
}

/**
 * Why a session the ledger doesn't link may still belong to a commit, strongest first. None of
 * them links on its own; each names the entries that show it.
 * - `write`: a shell command wrote a commit file in a way `editedPaths` can't read from its words:
 *   a diff applied through the shell (`git apply`, `patch`, `apply_patch` with the patch inline or
 *   its output naming files), or `git mv|rm|restore|checkout -- <path>`.
 * - `staged`: `git add <path>` (or `-A`, `.`, `-u`, `commit -a`), the work handed to a commit.
 * - `script`: any other command that isn't a read names a commit file, in its words or its inline
 *   script (`python - <<EOF`, `node -e`, a formatter's `--write`): what shell-only agents do.
 * - `inspected`: `git diff|status|show` naming a commit file, in its words or its output.
 * - `read`: a read tool or reader command on a commit file.
 * - `active`: it ran actions here between the commit's parent and the commit.
 */
export const SIGNAL_KINDS = ["write", "staged", "script", "inspected", "read", "active"] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];
export type Signal = {
  readonly kind: SignalKind;
  /** Entry ids that show it. */
  readonly ids: ReadonlyArray<string>;
  /** Commit files it names, when it names any. */
  readonly paths: ReadonlyArray<string>;
};

const GIT_INSPECT = new Set(["diff", "status", "show"]);
const READERS = /^(cat|head|tail|nl|less|bat|sed|awk|wc|rg|grep|ls|find|fd|jq|diff)$/;
// Diff file headers: unified (`+++ b/x`, `diff --git a/x b/x`) and Codex's `apply_patch` format.
const DIFF_HEADERS =
  /^(?:\+\+\+|---) (?:[ab]\/)?(\S+)|^diff --git a\/(\S+) b\/(\S+)|^\*\*\* (?:Update|Add|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;
// What `patch` and `git apply -v` print for each file they change.
const APPLIED = /^patching file '?([^'\n]+)'?$|^Applied patch (?:to )?'?([^'\n]+?)'? cleanly\.?$/gm;
// A word that may be a path: split on shell and code punctuation, then `:line[:col]` dropped.
const WORD_BREAK = /[\s'"`(),;=<>|&{}[\]]+/;

const groups = (re: RegExp, text: string) =>
  [...text.matchAll(re)].flatMap((m) => m.slice(1).filter((g): g is string => !!g));
const words = (text: string) =>
  text
    .split(WORD_BREAK)
    .map((w) => w.replace(/(?::\d+){1,2}$/, "").replace(/[.:]$/, ""))
    .filter((w) => w.length > 0 && w !== "/dev/null");

/** `git [-C dir] [-c k=v] <sub> <rest>` of one pipeline stage, past env assignments. */
function gitArgs(stage: ReadonlyArray<string>): { sub: string; rest: string[] } | null {
  let i = 0;
  while (i < stage.length && /^[A-Za-z_]\w*=/.test(stage[i]!)) i++;
  if (stage[i]?.replace(/^.*\//, "") !== "git") return null;
  i++;
  while (i < stage.length && stage[i]!.startsWith("-")) i += /^-[Cc]$/.test(stage[i]!) ? 2 : 1;
  return { sub: stage[i] ?? "", rest: stage.slice(i + 1) };
}

const exe = (stage: ReadonlyArray<string>) =>
  stage.find((w) => !/^[A-Za-z_]\w*=/.test(w))?.replace(/^.*\//, "") ?? "";

/** The signals `segment` shows for a commit that changed `paths`. */
export function signalsFor(
  segment: ReadonlyArray<Entry>,
  paths: ReadonlyArray<string>,
  where: PathWhere = {},
): Signal[] {
  const commitPath = commitPathMatcher(paths, where);
  const found = new Map<SignalKind, { ids: Set<string>; paths: Set<string> }>();
  const hit = (kind: SignalKind, id: string, named: ReadonlyArray<string> | null) => {
    const matched = named?.flatMap((w) => commitPath(w) ?? []) ?? [];
    if (named && matched.length === 0) return false;
    const s = found.get(kind) ?? { ids: new Set(), paths: new Set() };
    s.ids.add(id);
    for (const p of matched) s.paths.add(p);
    found.set(kind, s);
    return true;
  };
  for (const e of segment) {
    if (e.type !== "action" || e.status === "failed") continue;
    hit("active", e.id, null);
    if (!e.command) {
      if (e.kind === "read" || e.kind === "search") hit("read", e.id, e.targets ?? []);
      continue;
    }
    const script = unwrapShell(e.command.trim());
    const stages = splitCommand(script).flat();
    const output = e.output ?? "";
    let strong = false;
    const applies = stages.some((s) => {
      const g = gitArgs(s);
      return g ? g.sub === "apply" : /^(patch|apply_patch)$/.test(exe(s));
    });
    if (applies)
      strong = hit("write", e.id, [...groups(DIFF_HEADERS, script), ...groups(APPLIED, output)]);
    for (const stage of stages) {
      const g = gitArgs(stage);
      if (!g) {
        if (READERS.test(exe(stage))) hit("read", e.id, stage.slice(1));
        continue;
      }
      const args = g.rest.filter((a) => !a.startsWith("-"));
      if (g.sub === "mv" || g.sub === "rm") strong = hit("write", e.id, args) || strong;
      else if (
        g.sub === "restore" &&
        !(g.rest.includes("--staged") && !g.rest.includes("--worktree"))
      )
        strong = hit("write", e.id, args) || strong;
      else if (g.sub === "checkout" && g.rest.includes("--"))
        strong = hit("write", e.id, g.rest.slice(g.rest.indexOf("--") + 1)) || strong;
      else if (g.sub === "add") {
        const all = g.rest.some((a) => /^(-A|--all|-u|--update|\.)$/.test(a));
        strong = hit("staged", e.id, all ? null : args) || strong;
      } else if (g.sub === "commit" && g.rest.some((a) => /^-[a-zA-Z]*a/.test(a)))
        strong = hit("staged", e.id, null) || strong;
      else if (GIT_INSPECT.has(g.sub)) hit("inspected", e.id, [...args, ...words(output)]);
    }
    // Anything else that names a commit file: the words, heredoc bodies and inline code included.
    const reads = stages.every((s) => READERS.test(exe(s)) || gitArgs(s) !== null);
    if (!strong && !reads) hit("script", e.id, words(script));
  }
  return SIGNAL_KINDS.flatMap((kind) => {
    const s = found.get(kind);
    return s ? [{ kind, ids: [...s.ids], paths: [...s.paths] }] : [];
  });
}

/** A session a commit's links leave out but its signals point at: a person decides. */
export type Candidate = {
  readonly commit: LinkCommit;
  readonly thread: LedgerThread;
  readonly labels: Labels;
  /** History from the commit's parent to the commit, as an evidence link would hold. */
  readonly segment: ReadonlyArray<Entry>;
  readonly signals: ReadonlyArray<Signal>;
};

export type Scope = {
  /** Every (commit, link) to take: role, via and segment as the ledger has them. */
  readonly take: ReadonlyArray<{ readonly commit: LinkCommit; readonly link: FoundLink }>;
  /** Strongest signal first. Never taken without a decision. */
  readonly candidates: ReadonlyArray<Candidate>;
  /** Commits nothing links. */
  readonly unmatched: ReadonlyArray<LinkCommit>;
  readonly ambiguous: ReadonlyArray<{
    readonly commit: LinkCommit;
    readonly sessions: ReadonlyArray<string>;
  }>;
};

/**
 * What checkpoints of a range take: each commit's links, and nothing else. Sessions here that a
 * commit doesn't link but whose window shows a signal go to `candidates`; sessions with neither are
 * left out. A commit with no files (a merge) gets no candidates: its branch's commits carry them.
 */
export function selectScope<S extends LinkSession>(
  links: ReadonlyArray<CommitLinks>,
  sessions: ReadonlyArray<S>,
  where: PathWhere = {},
): Scope {
  const rank = (j: Candidate) => SIGNAL_KINDS.indexOf(j.signals[0]!.kind);
  const take = links.flatMap((r) => r.links.map((link) => ({ commit: r.commit, link })));
  const candidates = links.flatMap((r) => {
    if (r.commit.paths.length === 0) return [];
    const linked = new Set(r.links.map((l) => l.thread.id));
    return sessions.flatMap((s): Candidate[] => {
      if (!s.here || linked.has(s.thread.id)) return [];
      const segment = segmentByTime(s.entries, r.commit.previousAt, r.commit.commit.committedAt);
      const signals = signalsFor(segment, r.commit.paths, where);
      return signals.length > 0
        ? [{ commit: r.commit, thread: s.thread, labels: s.labels, segment, signals }]
        : [];
    });
  });
  return {
    take,
    candidates: candidates.sort((a, b) => rank(a) - rank(b)),
    unmatched: links.filter((r) => r.links.length === 0 && !r.ambiguous).map((r) => r.commit),
    ambiguous: links.flatMap((r) =>
      r.ambiguous ? [{ commit: r.commit, sessions: r.ambiguous }] : [],
    ),
  };
}
