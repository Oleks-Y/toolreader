// Project Insights: patterns across a repo's sessions that a person may want to act on, each
// citing the sessions and entries it rests on, with a next step to take. Two detectors:
//   - recurring failures: the same failure (by a normalized signature) in independent sessions,
//     and whether each session went on to pass the same kind of check (an observed sequence,
//     never a cause);
//   - repeated investigations: the same file read, and not edited, in independent sessions.
// Sessions are independent when they don't share a root (a subagent counts with its parent).
// Deterministic and pure; findings go through the lifecycle in `FINDING_STATUSES`.
import * as Schema from "effect/Schema";

import type { Action, Entry } from "./domain.ts";

export const DETECTORS = ["recurring-failure", "repeated-investigation"] as const;

/** Detected → Proposed → Accepted, Rejected or Modified → Implemented → Monitoring → Evaluated. */
export const FINDING_STATUSES = [
  "detected",
  "proposed",
  "accepted",
  "rejected",
  "modified",
  "implemented",
  "monitoring",
  "evaluated",
] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** Where each status may go. A rejected finding stays rejected until someone proposes it again. */
export const TRANSITIONS: Readonly<Record<FindingStatus, ReadonlyArray<FindingStatus>>> = {
  detected: ["proposed", "rejected"],
  proposed: ["accepted", "rejected", "modified"],
  modified: ["accepted", "rejected", "implemented"],
  accepted: ["implemented", "rejected"],
  rejected: ["proposed"],
  implemented: ["monitoring"],
  monitoring: ["evaluated"],
  evaluated: [],
};

export const Occurrence = Schema.Struct({
  threadId: Schema.String,
  entryId: Schema.String,
  at: Schema.String,
  /** For a failure: whether the session later passed the same kind of check. */
  recovered: Schema.optional(Schema.Boolean),
});
export type Occurrence = typeof Occurrence.Type;

/** What a detector found; `key` is stable across runs, so a decision on it holds. */
export const Detection = Schema.Struct({
  key: Schema.String,
  detector: Schema.Literals(DETECTORS),
  /** The failure signature, or the file. */
  subject: Schema.String,
  /** Independent sessions it was seen in. */
  sessions: Schema.Number,
  occurrences: Schema.Array(Occurrence),
  /** What was observed, in a sentence. */
  pattern: Schema.String,
  /** A step a person could take; a suggestion, not a diagnosis. */
  suggestion: Schema.String,
});
export type Detection = typeof Detection.Type;

export type InsightThread = {
  readonly id: string;
  readonly parent: string | null;
  readonly entries: ReadonlyArray<Entry>;
};

/** A terminal color code (ESC [ … m). */
const COLOR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** At least this many independent sessions make a pattern (a starting setting, not tuned). */
export const MIN_SESSIONS = 2;
/** Occurrences kept per finding: the newest. */
const MAX_OCCURRENCES = 20;

/**
 * A failure as it reads across sessions: its telling line, with numbers, ids, quoted text and
 * paths made alike. `null` when nothing in it is telling.
 */
export function failureSignature(a: Action): string | null {
  const lines = (a.output ?? "")
    // Terminal colors, and Claude Code's header on any failed command, say nothing.
    .replaceAll(COLOR, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^error: exit code \d+$/i.test(l));
  // The error itself first: a runner's `FAIL <file>` line names where, not what.
  const line =
    lines.find((l) => /\b(?:\w*error|exception|cannot|not found|denied|panic)\b/i.test(l)) ??
    lines.find((l) => /\bfail(?:ed|ure)?\b/i.test(l)) ??
    lines.at(-1);
  if (!line) return null;
  const sig = line
    .toLowerCase()
    .replace(/(?:[a-z]:)?(?:[\w.~@-]*\/)+[\w.@-]+/g, "<path>")
    .replace(/\b[\w-]+(?:\.[\w-]+)*\.[a-z]{1,5}\b/g, "<path>")
    .replace(/(["'`]).*?\1/g, "<text>")
    .replace(/\b[0-9a-f]{7,}\b/g, "<id>")
    .replace(/\d+(?:\.\d+)*/g, "#")
    .replace(/\s+/g, " ")
    .slice(0, 160);
  return /[a-z]{3}/.test(sig) ? `${a.kind}: ${sig}` : null;
}

// ponytail: sessions in different worktrees name one file by different absolute paths, so a file
// is its last three path segments. Two files that share them merge; key by repo-relative paths
// once sessions record their worktree root.
const fileKey = (path: string) => path.replace(/^\.\//, "").split("/").slice(-3).join("/");

const actions = (t: InsightThread) => t.entries.flatMap((e) => (e.type === "action" ? [e] : []));

/** The pattern's independent sessions: one per root thread. */
const roots = (occurrences: ReadonlyArray<Occurrence>, root: (id: string) => string) =>
  new Set(occurrences.map((o) => root(o.threadId))).size;

const newest = (occurrences: Occurrence[]) =>
  occurrences.sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_OCCURRENCES);

export function detect(threads: ReadonlyArray<InsightThread>): Detection[] {
  const parentOf = new Map(threads.map((t) => [t.id, t.parent]));
  const root = (id: string): string => {
    const seen = new Set<string>();
    let at = id;
    while (parentOf.get(at) && !seen.has(at)) {
      seen.add(at);
      at = parentOf.get(at)!;
    }
    return at;
  };

  // Failures: a failed run, build, test or tool call with a telling output. A search that found
  // nothing, a cancelled or unrecorded outcome, isn't a failure.
  const failures = new Map<string, Occurrence[]>();
  for (const t of threads) {
    const acts = actions(t);
    acts.forEach((a, i) => {
      if (a.status !== "failed" || a.noMatch || a.kind === "search" || a.kind === "read") return;
      const sig = failureSignature(a);
      if (!sig) return;
      const recovered = acts.slice(i + 1).some((b) => b.kind === a.kind && b.status === "ok");
      failures.set(sig, [
        ...(failures.get(sig) ?? []),
        { threadId: t.id, entryId: a.id, at: a.at, recovered },
      ]);
    });
  }

  // Investigations: files a session read and never edited.
  const reads = new Map<string, Occurrence[]>();
  for (const t of threads) {
    const acts = actions(t);
    const edited = new Set(acts.flatMap((a) => (a.files ?? []).map((f) => fileKey(f.path))));
    const first = new Map<string, Action>();
    for (const a of acts)
      if (a.kind === "read")
        for (const p of a.targets ?? []) {
          const k = fileKey(p);
          if (!edited.has(k) && !first.has(k)) first.set(k, a);
        }
    for (const [k, a] of first)
      reads.set(k, [...(reads.get(k) ?? []), { threadId: t.id, entryId: a.id, at: a.at }]);
  }

  const found: Detection[] = [];
  for (const [sig, occ] of failures) {
    const sessions = roots(occ, root);
    if (sessions < MIN_SESSIONS) continue;
    const recovered = occ.filter((o) => o.recovered).length;
    found.push({
      key: `recurring-failure:${sig}`,
      detector: "recurring-failure",
      subject: sig,
      sessions,
      occurrences: newest([...occ]),
      pattern: `${occ.length} failure${occ.length === 1 ? "" : "s"} with this signature in ${sessions} independent sessions; ${recovered} were followed by a passing ${sig.split(":")[0]} in the same session.`,
      suggestion:
        recovered > 0
          ? "Read how the sessions that recovered got past it, and write that down where agents will see it (AGENTS.md, a doc, a clearer error), or fix the cause."
          : "No session recovered in place: look at the cause before agents hit it again.",
    });
  }
  for (const [file, occ] of reads) {
    const sessions = roots(occ, root);
    if (sessions < MIN_SESSIONS) continue;
    found.push({
      key: `repeated-investigation:${file}`,
      detector: "repeated-investigation",
      subject: file,
      sessions,
      occurrences: newest([...occ]),
      pattern: `${sessions} independent sessions read ${file} without editing it.`,
      suggestion: `If agents read ${file} to answer the same question each time, put the answer where they start (AGENTS.md, a doc comment, a test that shows it). Repetition isn't waste by itself: check what they were after first.`,
    });
  }
  return found.sort((a, b) => b.sessions - a.sessions || a.key.localeCompare(b.key));
}

export const FindingEvent = Schema.Struct({
  from: Schema.Literals(FINDING_STATUSES),
  to: Schema.Literals(FINDING_STATUSES),
  /** The token that made the change (its name), until sign-in names people. */
  by: Schema.String,
  at: Schema.String,
  why: Schema.String,
});
export type FindingEvent = typeof FindingEvent.Type;

/** A detection as the backend keeps it: with its status and how it got there. */
export const Finding = Schema.Struct({
  ...Detection.fields,
  /** Short and stable (from `key`): what a person types to act on it. */
  id: Schema.String,
  status: Schema.Literals(FINDING_STATUSES),
  events: Schema.Array(FindingEvent),
  detectedAt: Schema.String,
  updatedAt: Schema.String,
});
export type Finding = typeof Finding.Type;

/** Why a status change isn't allowed, or null when it is. */
export function transitionError(from: FindingStatus, to: FindingStatus): string | null {
  return TRANSITIONS[from].includes(to)
    ? null
    : `a ${from} finding can go to ${TRANSITIONS[from].join(" or ") || "nothing"}, not ${to}`;
}
