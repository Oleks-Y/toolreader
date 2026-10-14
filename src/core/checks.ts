// The checks behind a commit: each test or build a linked session ran, from its first linked turn
// up to the commit, with its outcome, what that outcome rests on, and how many of the commit's lines
// the session wrote after it ran (lines the check never saw). Matching is by content, as linking
// is (history.ts), so edits the commit doesn't contain never count against a check. What this
// can't see: edits that only removed or changed lines, other writers, the tree's state. Pure.
import * as Schema from "effect/Schema";

import type { Action, Entry } from "./domain.ts";
import { addedLines, isTelling, turnId } from "./history.ts";
import { splitTurns } from "./tree.ts";

export const CHECK_KINDS = ["test", "build"] as const;

export const Check = Schema.Struct({
  actionId: Schema.String,
  /** The turn it ran in. */
  turn: Schema.String,
  at: Schema.String,
  kind: Schema.Literals(CHECK_KINDS),
  /** The command as the viewer titles it (redacted in records). */
  title: Schema.String,
  outcome: Schema.Literals(["passed", "failed", "interrupted", "unknown"]),
  /** What the outcome rests on: a recorded exit code, the provider's error flag, or nothing. */
  basis: Schema.Literals(["exit code", "error flag", "none"]),
  /** The command can't fail (`|| true`): whatever it printed, its outcome is unknown. */
  masked: Schema.optional(Schema.Boolean),
  /** The commit's lines this session wrote after the check ran. */
  linesAfter: Schema.Number,
});
export type Check = typeof Check.Type;

/** A shell tail that turns any failure into success. */
const MASKED = /\|\|\s*(?:true|:)\s*(?:$|[;&|)])|;\s*true\s*$/;

/** Ignores clock skew between the agent's machine and the committer's, as linking does. */
const CLOCK_SKEW_MS = 2_000;

const outcomeOf = (a: Action): Pick<Check, "outcome" | "basis"> => {
  const basis =
    a.exitCode !== undefined
      ? "exit code"
      : a.status === "ok" || a.status === "failed"
        ? "error flag"
        : "none";
  const outcome =
    a.status === "ok"
      ? "passed"
      : a.status === "failed"
        ? "failed"
        : a.status === "running"
          ? "interrupted"
          : "unknown";
  return { outcome, basis };
};

/**
 * The checks one linked session ran for a commit. `turns` are the linked turns (empty: from the
 * session's start); `novel` the commit's new lines (`lineKey`s); checks after `committedAt` are
 * left out, as the commit couldn't have rested on them.
 */
export function checksFor(input: {
  readonly entries: ReadonlyArray<Entry>;
  readonly turns: ReadonlyArray<string>;
  readonly novel: ReadonlyArray<string>;
  readonly committedAt: string;
}): Check[] {
  const novel = new Set(input.novel.filter(isTelling));
  const until = Date.parse(input.committedAt) + CLOCK_SKEW_MS;
  const linked = new Set(input.turns);
  const turns = splitTurns(input.entries).map((t) => ({
    id: turnId(t.prompt, t.entries),
    entries: t.entries,
  }));
  const first = linked.size === 0 ? 0 : turns.findIndex((t) => linked.has(t.id));
  if (first < 0) return [];
  const actions = turns
    .slice(first)
    .flatMap((t) =>
      t.entries.flatMap((e) =>
        e.type === "action" && Date.parse(e.at) <= until ? [{ turn: t.id, action: e }] : [],
      ),
    );
  // Each commit line, with when this session first wrote it.
  const written = new Map<string, number>();
  for (const { action } of actions)
    if (action.status !== "failed")
      for (const f of action.files ?? [])
        for (const l of f.addedKeys ?? (f.diff ? addedLines(f.diff) : []))
          if (novel.has(l) && !written.has(l)) written.set(l, Date.parse(action.at));
  return actions.flatMap(({ turn, action }) => {
    const kind = CHECK_KINDS.find((k) => k === action.kind);
    if (!kind) return [];
    const at = Date.parse(action.at);
    const masked = MASKED.test(action.command ?? "");
    const { outcome, basis } = outcomeOf(action);
    return [
      {
        actionId: action.id,
        turn,
        at: action.at,
        kind,
        title: action.title,
        outcome: masked ? "unknown" : outcome,
        basis,
        ...(masked ? { masked: true } : {}),
        linesAfter: [...written.values()].filter((w) => w > at).length,
      },
    ];
  });
}
