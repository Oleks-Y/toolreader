// What the Insights page shows of a finding, beyond the record: which tab it's in, the steps a
// person can take next, whether the detector brought it back, and what came after a change.
import { TRANSITIONS, type Finding, type FindingStatus } from "../core/insights.ts";

export const TABS = {
  open: ["detected", "proposed"],
  accepted: ["accepted", "modified", "implemented", "monitoring"],
  rejected: ["rejected"],
  done: ["evaluated"],
} as const satisfies Record<string, ReadonlyArray<FindingStatus>>;
export type Tab = keyof typeof TABS;

export const tabOf = (status: FindingStatus): Tab =>
  (Object.keys(TABS) as Tab[]).find((t) =>
    (TABS[t] as ReadonlyArray<FindingStatus>).includes(status),
  )!;

const STEP: Partial<Record<FindingStatus, string>> = {
  proposed: "Propose",
  accepted: "Accept",
  rejected: "Reject",
  implemented: "Change made",
  monitoring: "Watch later sessions",
  evaluated: "Mark evaluated",
};

/** The steps the lifecycle allows from here, as buttons. Modifying isn't offered here. */
export const nextSteps = (status: FindingStatus) =>
  TRANSITIONS[status].flatMap((to) => (STEP[to] ? [{ to, label: STEP[to] }] : []));

/** When the detector proposed a rejected finding again: why, and the rejection it overrides. */
export function reopened(f: Finding) {
  const last = f.events.at(-1);
  if (!last || last.from !== "rejected" || last.to !== "proposed" || last.by !== "detector")
    return null;
  const rejection = f.events.findLast((e) => e.to === "rejected") ?? null;
  return { why: last.why, rejection };
}

/** Sessions seen after the change was recorded, and before it; observed, not an effect. */
export function sinceChange(f: Finding) {
  const change = f.events.findLast((e) => e.to === "implemented");
  if (!change) return null;
  const sessions = (keep: (at: string) => boolean) =>
    new Set(f.occurrences.filter((o) => o.at && keep(o.at)).map((o) => o.threadId)).size;
  return {
    change,
    after: sessions((at) => at > change.at),
    before: sessions((at) => at <= change.at),
  };
}

/** For a recurring failure: sessions that later passed the same kind of check, and the rest. */
export function recovery(f: Finding) {
  if (f.detector !== "recurring-failure") return null;
  const by = (r: boolean) =>
    new Set(f.occurrences.filter((o) => (o.recovered ?? false) === r).map((o) => o.threadId)).size;
  return { recovered: by(true), unresolved: by(false) };
}
