// A range's agent history as the ledger page shows it (`LedgerRange`), from the backend's records:
// each commit's links, each shown as its episode, the linked turns of the thread and the few
// turns between them (the reads, runs and talk that explain the edits). Pure.
import type { Entry } from "./domain.ts";
import { turnId } from "./history.ts";
import type { CommitRecord, ThreadRecord } from "./historyRecord.ts";
import { buildEntry, type FoundLink, type LedgerCommit, type LedgerRange } from "./ledger.ts";
import { splitTurns } from "./tree.ts";

/** Unlinked turns between two linked ones that stay in an episode; a longer run splits it. */
const GAP = 3;

/** The episode of `turns` in a thread: those turns and the short runs between them, in order. */
export function episode(entries: ReadonlyArray<Entry>, turns: ReadonlySet<string>): Entry[] {
  const all = splitTurns(entries).map((t) => ({
    id: turnId(t.prompt, t.entries),
    entries: [...(t.prompt ? [t.prompt] : []), ...t.entries],
  }));
  const linked = all.flatMap((t, i) => (turns.has(t.id) ? [i] : []));
  const kept: Entry[] = [];
  linked.forEach((at, k) => {
    const next = linked[k + 1];
    kept.push(...all[at]!.entries);
    if (next !== undefined && next - at - 1 <= GAP)
      for (let i = at + 1; i < next; i++) kept.push(...all[i]!.entries);
  });
  return kept;
}

export function historyRange(input: {
  readonly repo: string;
  readonly range: string;
  readonly remoteUrl: string | null;
  /** Oldest first, with the files each changed (for the page's file coverage). */
  readonly commits: ReadonlyArray<{
    readonly commit: LedgerCommit;
    readonly paths: ReadonlyArray<string>;
    readonly record: CommitRecord | null;
  }>;
  readonly threads: ReadonlyMap<string, ThreadRecord>;
  /**
   * The repo's worktrees and the home directory: threads write paths absolute or as `~/…`, and
   * only these say which commit file a written path is.
   */
  readonly roots?: ReadonlyArray<string>;
  readonly home?: string | undefined;
}): LedgerRange {
  return {
    repo: input.repo,
    range: input.range,
    remoteUrl: input.remoteUrl,
    commits: input.commits.map(({ commit, paths, record }) => {
      if (!record || record.links.length === 0) return { commit, entry: null, matchedBy: null };
      const links = record.links.flatMap((l): FoundLink[] => {
        const thread = input.threads.get(l.threadId);
        if (!thread) return [];
        return [
          {
            thread: thread.thread,
            // Testing, reviewing or deploying it: its edits aren't the commit's.
            role: l.role ? "reviewer" : "coder",
            via: l.via,
            reviewedSha: null,
            // Named entries alone; a trailer alone names the thread: all of it, as far as the
            // backend has it.
            segment: l.entries?.length
              ? thread.entries.filter((e) => l.entries!.includes(e.id))
              : l.turns.length > 0
                ? episode(thread.entries, new Set(l.turns))
                : thread.entries,
            labels: thread.labels,
            checks: l.checks,
            reads: l.reads,
            claim: l.role ?? "implemented",
            environment: l.environment,
            testedSha: l.testedSha,
          },
        ];
      });
      const entry = buildEntry({
        commit,
        links,
        paths,
        roots: input.roots,
        home: input.home,
        notes: [
          ...(record.explained > 0
            ? [
                {
                  text: `${record.explained} of the ${record.novel} lines it adds that weren't in the repo before match its agents' edits.`,
                  file: null,
                  at: record.linkedAt,
                },
              ]
            : []),
          // What the agents said when they declared their links.
          ...record.links.flatMap((l) =>
            l.via === "asserted" && l.note
              ? [
                  {
                    text: `${input.threads.get(l.threadId)?.thread.title ?? l.threadId}: ${l.note}`,
                    file: null,
                    at: record.linkedAt,
                  },
                ]
              : [],
          ),
        ],
        outputs: true,
        maxOutput: 0,
      });
      return { commit, entry, matchedBy: "sha" };
    }),
  };
}
