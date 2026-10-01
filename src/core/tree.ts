import { ACTION_KINDS } from "./domain.ts";
import type { Action, ActionKind, Entry, Event, Message } from "./domain.ts";

export type Switches = {
  kinds: Record<ActionKind, boolean>;
  notes: boolean;
  reasoning: boolean;
  failuresOnly: boolean;
  foldReads: boolean;
  phases: boolean;
};

export const DEFAULT_SWITCHES: Switches = {
  kinds: Object.fromEntries(ACTION_KINDS.map((k) => [k, true])) as Record<ActionKind, boolean>,
  notes: true,
  reasoning: false,
  failuresOnly: false,
  foldReads: true,
  phases: true,
};

export type PhaseName = "explore" | "edit" | "verify" | "fix" | "ship" | "all";
export type Fold = {
  type: "fold";
  id: string;
  at: string;
  actions: Action[];
  summary: string;
  targets: string[];
};
export type Item = Action | Fold | Message | Event;
export type Phase = { id: string; name: PhaseName; items: Item[]; start: string; end: string };
export type TurnStats = {
  actions: number;
  failed: number;
  files: number;
  added: number;
  removed: number;
  start: string;
  end: string;
};
export type Turn = {
  id: string;
  index: number;
  prompt: Message | null;
  phases: Phase[];
  stats: TurnStats;
  actions: Action[];
};

const isFoldable = (a: Action) =>
  (a.kind === "read" || a.kind === "search") && a.status !== "failed";

/** Kinds that check edits: running one after an edit starts a verify phase. */
const VERIFY_KINDS = new Set<ActionKind>(["run", "build", "test", "docker"]);

/** Assigns each action a phase: explore → edit → verify → fix → ship, per turn. */
export function assignPhases(actions: Action[]): Map<string, PhaseName> {
  const out = new Map<string, PhaseName>();
  let state = "explore" as PhaseName;
  let hadEdit = false;
  for (const a of actions) {
    if (a.kind === "edit") {
      state = state === "verify" || state === "ship" ? "fix" : state === "explore" ? "edit" : state;
      hadEdit = true;
    } else if (VERIFY_KINDS.has(a.kind) && hadEdit) {
      state = "verify";
    } else if (a.kind === "git" && hadEdit) {
      state = "ship";
    }
    out.set(a.id, state);
  }
  return out;
}

function splitTurns(
  entries: ReadonlyArray<Entry>,
): Array<{ prompt: Message | null; entries: Entry[] }> {
  const turns: Array<{ prompt: Message | null; entries: Entry[] }> = [];
  let current: { prompt: Message | null; entries: Entry[] } = { prompt: null, entries: [] };
  for (const e of entries) {
    if (e.type === "message" && e.role === "user") {
      if (current.prompt || current.entries.length) turns.push(current);
      current = { prompt: e, entries: [] };
    } else current.entries.push(e);
  }
  if (current.prompt || current.entries.length) turns.push(current);
  return turns;
}

function tail(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || path;
}

export function summarizeFold(actions: Action[]): { summary: string; targets: string[] } {
  const reads = actions.filter((a) => a.kind === "read").length;
  const searches = actions.length - reads;
  const counts = [
    reads && `${reads} read${reads > 1 ? "s" : ""}`,
    searches && `${searches} search${searches > 1 ? "es" : ""}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const seen = new Map<string, number>();
  for (const a of actions)
    for (const t of a.targets ?? []) seen.set(tail(t), (seen.get(tail(t)) ?? 0) + 1);
  const targets = [...seen.entries()].sort((x, y) => y[1] - x[1]).map(([t]) => t);
  return { summary: counts, targets };
}

function stats(
  actions: Action[],
  prompt: Message | null,
  entries: ReadonlyArray<Entry>,
): TurnStats {
  const files = new Map<string, { added: number; removed: number }>();
  for (const a of actions)
    for (const f of a.files ?? []) {
      const s = files.get(f.path) ?? { added: 0, removed: 0 };
      s.added += f.added;
      s.removed += f.removed;
      files.set(f.path, s);
    }
  const all = [...files.values()];
  return {
    actions: actions.length,
    failed: actions.filter((a) => a.status === "failed").length,
    files: files.size,
    added: all.reduce((n, s) => n + s.added, 0),
    removed: all.reduce((n, s) => n + s.removed, 0),
    start: prompt?.at ?? entries[0]?.at ?? "",
    end: entries.at(-1)?.at ?? prompt?.at ?? "",
  };
}

function visible(e: Entry, sw: Switches, range: { from: string; to: string } | null): boolean {
  if (range && (e.at < range.from || e.at > range.to)) return false;
  if (e.type === "action") return sw.kinds[e.kind] && (!sw.failuresOnly || e.status === "failed");
  if (e.type === "event") return !sw.failuresOnly || e.tone === "error";
  if (sw.failuresOnly) return false;
  return e.role === "assistant" ? sw.notes : e.role === "reasoning" ? sw.reasoning : true;
}

/** Builds the turn → phase → (fold | entry) tree for the current switches. */
export function buildTree(
  entries: ReadonlyArray<Entry>,
  sw: Switches,
  range: { from: string; to: string } | null = null,
): Turn[] {
  return splitTurns(entries).map((turn, index) => {
    const actions = turn.entries.filter((e): e is Action => e.type === "action");
    const phaseOf = assignPhases(actions);
    const phases: Phase[] = [];
    let phase: PhaseName = "explore";
    for (const e of turn.entries) {
      if (e.type === "action") phase = phaseOf.get(e.id) ?? phase;
      if (!visible(e, sw, range)) continue;
      const name: PhaseName = sw.phases ? phase : "all";
      let current = phases.at(-1);
      if (!current || current.name !== name) {
        current = {
          id: `${turn.prompt?.id ?? index}:${phases.length}`,
          name,
          items: [],
          start: e.at,
          end: e.at,
        };
        phases.push(current);
      }
      current.end = e.at;
      const last = current.items.at(-1);
      if (sw.foldReads && e.type === "action" && isFoldable(e)) {
        if (last?.type === "fold") {
          last.actions.push(e);
          continue;
        }
        if (last?.type === "action" && isFoldable(last)) {
          current.items[current.items.length - 1] = {
            type: "fold",
            id: `fold:${last.id}`,
            at: last.at,
            actions: [last, e],
            summary: "",
            targets: [],
          };
          continue;
        }
      }
      current.items.push(e);
    }
    for (const p of phases)
      for (const item of p.items)
        if (item.type === "fold") Object.assign(item, summarizeFold(item.actions));
    return {
      id: turn.prompt?.id ?? `turn:${index}`,
      index,
      prompt: turn.prompt,
      phases,
      stats: stats(actions, turn.prompt, turn.entries),
      actions,
    };
  });
}
