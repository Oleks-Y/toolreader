// Which agent turns wrote a commit, by content: a turn is linked when lines its edits added are
// lines the commit adds and the repo didn't have before. Where or when the turn ran doesn't
// matter (another worktree, days before a split or rebase, a file the commit has since moved), so
// a commit made long after the work, or split out of a bigger change, still finds its history.
// Pure: the CLI reads commits from git and threads from the session stores.
import type { Check } from "./checks.ts";
import type { Reads } from "./coverage.ts";
import type { Entry } from "./domain.ts";
import { splitTurns } from "./tree.ts";

/** A commit, with the lines it adds that its parent didn't have anywhere (`novel`). */
export type CommitLines = {
  readonly sha: string;
  readonly committedAt: string;
  /** `Agent-Session` trailer values: threads named outright. */
  readonly trailers: ReadonlyArray<string>;
  /** Added lines, normalized (`lineKey`), that its parent's tree doesn't hold. */
  readonly novel: ReadonlyArray<string>;
};

/** One thread's whole history, as the session stores have it. */
export type HistoryThread = {
  readonly id: string;
  readonly entries: ReadonlyArray<Entry>;
};

export type ThreadLink = {
  readonly threadId: string;
  /** Turns (`turnId`) whose edits added the commit's lines; empty for a trailer alone. */
  readonly turns: ReadonlyArray<string>;
  /**
   * `asserted`: an agent declared it (`history link`, core/declare.ts); `content`: its edits wrote
   * the commit's lines; `trailer`: the commit names it.
   */
  readonly via: "asserted" | "content" | "trailer";
  /** The commit's novel lines these turns added. */
  readonly lines: number;
  /** Why, as the declaring agent put it. */
  readonly note?: string;
  /** The session that declared it, when that isn't this thread. */
  readonly declaredBy?: string;
  /** Its tests and builds for this commit (checks.ts), added by `history sync`. */
  readonly checks?: ReadonlyArray<Check>;
  /** The files its session was seen reading for this commit (coverage.ts), added by `history sync`. */
  readonly reads?: Reads;
  /** What it claims (declare.ts `EVIDENCE_ROLES`); absent: it implemented the commit. */
  readonly role?: "tested" | "reviewed" | "deployed";
  /** The entries that show it, when the declaration named entries instead of turns. */
  readonly entries?: ReadonlyArray<string>;
  /** The thread's content hash when the link was resolved: the version its turns and entries cite. */
  readonly version?: string;
  /** Where it ran (`staging`), and the commit it ran on, as the declaration said. */
  readonly environment?: string;
  readonly testedSha?: string;
};

export type CommitHistory = {
  readonly sha: string;
  /** Novel lines in the commit, and how many of them some linked turn added. */
  readonly novel: number;
  readonly explained: number;
  /** Most lines first. */
  readonly links: ReadonlyArray<ThreadLink>;
  /** Links declared away: the backend drops them from what other machines sent. */
  readonly unlinked?: ReadonlyArray<{
    readonly threadId: string;
    readonly role?: "implemented" | "tested" | "reviewed" | "deployed";
  }>;
  /** Each matched thread's novel lines, to recount `explained` when links change; never stored. */
  readonly hits?: ReadonlyMap<string, ReadonlySet<string>>;
};

/** A line as matched: trimmed, inner whitespace collapsed. */
export const lineKey = (line: string) => line.trim().replace(/\s+/g, " ");

/** Long enough and wordy enough to say who wrote it: not `}`, `});` or a blank. */
export const isTelling = (key: string) => key.length >= 12 && /[A-Za-z0-9]{3}/.test(key);

/**
 * The `+` lines of unified diff hunks, as `lineKey`s worth matching. A `+++ ` line is a file
 * header only right after a `--- ` one: an added source line can start with `++` (`++count;`).
 */
export function addedLines(diff: string): string[] {
  const lines = diff.split("\n");
  return lines
    .filter(
      (l, i) => l.startsWith("+") && !(l.startsWith("+++ ") && lines[i - 1]?.startsWith("--- ")),
    )
    .map((l) => lineKey(l.slice(1)))
    .filter(isTelling);
}

/** A turn's id: its prompt's, or its first entry's for a turn with no prompt. */
export const turnId = (prompt: Entry | null, entries: ReadonlyArray<Entry>) =>
  prompt?.id ?? `turn:${entries[0]?.id ?? ""}`;

/**
 * A thread links with at least this many of a commit's new lines, or half of them (a one-line
 * fix): one shared line is often a coincidence (a common call, a log message).
 */
const MIN_LINES = 3;

/** Ignores clock skew between the agent's machine and the committer's. */
const CLOCK_SKEW_MS = 2_000;

/** Each turn of a thread that added lines, with when each line was first added (ms). */
function turnLines(thread: HistoryThread): Array<{ id: string; lines: Map<string, number> }> {
  return splitTurns(thread.entries).flatMap((t) => {
    const lines = new Map<string, number>();
    for (const e of t.entries)
      if (e.type === "action" && e.status !== "failed")
        for (const f of e.files ?? [])
          for (const l of f.addedKeys ?? (f.diff ? addedLines(f.diff) : []))
            if (!lines.has(l)) lines.set(l, Date.parse(e.at));
    return lines.size > 0 ? [{ id: turnId(t.prompt, t.entries), lines }] : [];
  });
}

/**
 * Each commit's linked threads. `named` resolves a trailer value to thread ids (any of a
 * session's names).
 */
export function linkByContent(
  commits: ReadonlyArray<CommitLines>,
  threads: ReadonlyArray<HistoryThread>,
  named: (name: string) => ReadonlyArray<string> = () => [],
): CommitHistory[] {
  const read = threads.map((thread) => ({ id: thread.id, turns: turnLines(thread) }));
  return commits.map((c) => {
    const novel = new Set(c.novel.filter(isTelling));
    const until = Date.parse(c.committedAt) + CLOCK_SKEW_MS;
    const explained = new Set<string>();
    const links: ThreadLink[] = [];
    const hits = new Map<string, Set<string>>();
    for (const thread of read) {
      const turns: string[] = [];
      const hit = new Set<string>();
      for (const turn of thread.turns) {
        let any = false;
        // Written before the commit: a later turn re-adding the same text didn't write it.
        for (const [l, at] of turn.lines)
          if (at <= until && novel.has(l)) {
            hit.add(l);
            any = true;
          }
        if (any) turns.push(turn.id);
      }
      if (turns.length === 0 || (hit.size < MIN_LINES && hit.size * 2 < novel.size)) continue;
      for (const l of hit) explained.add(l);
      hits.set(thread.id, hit);
      links.push({ threadId: thread.id, turns, via: "content", lines: hit.size });
    }
    for (const id of new Set(c.trailers.flatMap(named)))
      if (!links.some((l) => l.threadId === id))
        links.push({ threadId: id, turns: [], via: "trailer", lines: 0 });
    links.sort((a, b) => b.lines - a.lines);
    return { sha: c.sha, novel: novel.size, explained: explained.size, links, hits };
  });
}
