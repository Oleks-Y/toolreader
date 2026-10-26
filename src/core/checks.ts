// The checks behind a commit: each test or build a linked session ran, from its first linked turn
// up to the commit, on three separate axes:
//   - outcome, and what it rests on (a recorded exit code, the provider's error flag, nothing);
//   - tested state: the code it ran on, `exact reconstructed` only by one of the supported
//     patterns (a commit in the session's own git output with no recorded change since; a known
//     start commit, a tree git showed clean, and only exact edits since), else `candidate` (the
//     start commit is known, what changed since can't be replayed exactly) or `unknown`;
//   - applicability to the commit: `same state` when it ran on the commit itself, `definitely
//     stale` only with scope evidence (the commit's lines written afterwards into a file the
//     command named, or a lockfile or config changed afterwards), else `unknown`, with reasons.
// An unrelated edit never makes a check stale; a recorded change being absent is never proof that
// nothing changed (other writers, unrecorded tools). Matching is by content, as linking is
// (history.ts). Test scope (what the command targeted) is kept apart from what behavior it
// verified, which this never claims. Pure.
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
  /** Files the command named: its test scope, as far as the command shows it. */
  scope: Schema.Array(Schema.String),
  testedState: Schema.Literals(["exact recorded", "exact reconstructed", "candidate", "unknown"]),
  /** The commit it ran on or started from, when known. */
  base: Schema.optional(Schema.String),
  applicability: Schema.Literals([
    "same state",
    "supported equivalent",
    "definitely stale",
    "unknown",
  ]),
  /** Why, for the tested state and the applicability, in that order. */
  reasons: Schema.Array(Schema.String),
  /** The rules that derived this (`CHECKS_METHOD`): a newer method recomputes, never edits. */
  method: Schema.String,
});
export type Check = typeof Check.Type;

/** The method version stored with each check; bump when a rule changes. */
export const CHECKS_METHOD = "checks/2";

/** Files every check depends on: a change to one after a check makes it stale whatever its scope. */
const SHARED_INPUT =
  /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|tsconfig[\w.-]*\.json|[\w-]+\.config\.[cm]?[jt]s)$/;
/** A path-looking word in a command: has a slash or a file extension. */
const PATHISH = /^[\w.@~/-]*(?:\/[\w.@-]+|\.[a-z]{1,5})$/i;
/** `[branch abc1234] subject`: what `git commit` prints. */
const COMMITTED = /^\[[^\]\s]+(?: \([^)]*\))? ([0-9a-f]{7,40})\]/m;
const CLEAN_TREE = /nothing to commit,? working tree clean/;
/** Kinds that only look: anything else may have changed files. */
const LOOKS = new Set(["read", "search", "test", "web", "agent"]);

const DIRTY_TREE = /Changes not staged for commit|Changes to be committed|Untracked files:/;

/** `clean` or `dirty` as git last showed the tree before the session's first edit, if it did. */
export function treeShownIn(entries: ReadonlyArray<Entry>): "clean" | "dirty" | undefined {
  let shown: "clean" | "dirty" | undefined;
  for (const e of entries) {
    if (e.type !== "action") continue;
    if (e.files?.length) break;
    if (e.kind !== "git") continue;
    if (CLEAN_TREE.test(e.output ?? "")) shown = "clean";
    else if (DIRTY_TREE.test(e.output ?? "")) shown = "dirty";
  }
  return shown;
}

/** Whether `path` (as an edit names it) is `name` (as a command names it). */
const samePath = (path: string, name: string) =>
  path === name || path.endsWith(`/${name.replace(/^\.\//, "")}`);

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
 * left out, as the commit couldn't have rested on them. `base` is the commit the session started
 * on, when its source recorded it; `others` when other linked sessions wrote the commit's lines.
 */
export function checksFor(input: {
  readonly entries: ReadonlyArray<Entry>;
  readonly turns: ReadonlyArray<string>;
  readonly novel: ReadonlyArray<string>;
  readonly committedAt: string;
  readonly sha?: string | undefined;
  readonly base?: string | undefined;
  readonly others?: ReadonlyArray<number> | undefined;
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
  // The whole session up to the commit: state before the first linked turn counts too.
  const all = turns.flatMap((t) =>
    t.entries.flatMap((e) =>
      e.type === "action" && Date.parse(e.at) <= until ? [{ turn: t.id, action: e }] : [],
    ),
  );
  const firstLinked = turns[first]!.id;
  const from = all.findIndex((a) => a.turn === firstLinked);
  // Each commit line with when and where this session first wrote it; each shared input changed.
  const written = new Map<string, { at: number; path: string }>();
  const shared: Array<{ at: number; path: string }> = [];
  for (const { action } of all)
    if (action.status !== "failed")
      for (const f of action.files ?? []) {
        if (SHARED_INPUT.test(f.path)) shared.push({ at: Date.parse(action.at), path: f.path });
        for (const l of f.addedKeys ?? (f.diff ? addedLines(f.diff) : []))
          if (novel.has(l) && !written.has(l))
            written.set(l, { at: Date.parse(action.at), path: f.path });
      }

  const stateOf = (i: number): Pick<Check, "testedState" | "base"> & { why: string } => {
    const before = all.slice(0, i).map((a) => a.action);
    // Pattern: a commit in the session's own git output, nothing recorded changing files since.
    const commitAt = before.findLastIndex(
      (a) => a.kind === "git" && a.status === "ok" && COMMITTED.test(a.output ?? ""),
    );
    if (commitAt >= 0) {
      const sha = COMMITTED.exec(before[commitAt]!.output ?? "")![1]!;
      const since = before.slice(commitAt + 1);
      if (since.every((a) => LOOKS.has(a.kind) && !a.files?.length))
        return {
          testedState: "exact reconstructed",
          base: sha,
          why: `ran on ${sha.slice(0, 8)}, which the session committed, with no recorded change since`,
        };
    }
    if (!input.base)
      return { testedState: "unknown", why: "the session's starting commit isn't recorded" };
    // Pattern: a known start, a tree git showed clean, then only exact edits.
    const clean = before.findIndex((a) => a.kind === "git" && CLEAN_TREE.test(a.output ?? ""));
    const replayable =
      clean >= 0 &&
      before.slice(0, clean).every((a) => LOOKS.has(a.kind) && !a.files?.length) &&
      before
        .slice(clean + 1)
        .every((a) =>
          a.kind === "edit"
            ? (a.files ?? []).every((f) => f.exactLines || f.isNew)
            : LOOKS.has(a.kind) && !a.files?.length,
        );
    return replayable
      ? {
          testedState: "exact reconstructed",
          base: input.base,
          why: `started on ${input.base.slice(0, 8)}, shown clean, with only exact edits since`,
        }
      : {
          testedState: "candidate",
          base: input.base,
          why:
            clean < 0
              ? `started on ${input.base.slice(0, 8)}; the tree was never shown clean`
              : `started on ${input.base.slice(0, 8)}; changes since can't be replayed exactly`,
        };
  };

  return all.slice(from).flatMap(({ turn, action }, j) => {
    const kind = CHECK_KINDS.find((k) => k === action.kind);
    if (!kind) return [];
    const i = from + j;
    const at = Date.parse(action.at);
    const masked = MASKED.test(action.command ?? "");
    const { outcome, basis } = outcomeOf(action);
    const scope = [
      ...new Set(
        (action.command ?? "")
          .split(/\s+/)
          .filter((w) => PATHISH.test(w) && !w.startsWith("-") && !w.includes("://")),
      ),
    ];
    const after = [...written.values()].filter((w) => w.at > at);
    const state = stateOf(i);
    const othersMeanwhile = (input.others ?? []).some((o) => o <= at);
    const inScope = after.filter((w) => scope.some((name) => samePath(w.path, name)));
    const sharedAfter = shared.filter((c) => c.at > at);
    const sameCommit =
      state.testedState === "exact reconstructed" &&
      !!input.sha &&
      !!state.base &&
      input.sha.startsWith(state.base) &&
      after.length === 0 &&
      !othersMeanwhile;
    const [applicability, why]: [Check["applicability"], string] = sameCommit
      ? ["same state", "it ran on this commit"]
      : inScope.length > 0
        ? [
            "definitely stale",
            `${inScope.length} of the commit's lines went into ${[...new Set(inScope.map((w) => w.path))].join(", ")}, which it named, after it ran`,
          ]
        : sharedAfter.length > 0
          ? [
              "definitely stale",
              `${[...new Set(sharedAfter.map((c) => c.path))].join(", ")} changed after it ran`,
            ]
          : [
              "unknown",
              after.length > 0
                ? `${after.length} of the commit's lines were written after it, outside what it named`
                : othersMeanwhile
                  ? "another session wrote the commit's lines too"
                  : "nothing shows it ran on this commit, or that it didn't",
            ];
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
        linesAfter: after.length,
        scope,
        testedState:
          othersMeanwhile && state.testedState === "exact reconstructed"
            ? "candidate"
            : state.testedState,
        ...(state.base ? { base: state.base } : {}),
        applicability,
        reasons: [
          othersMeanwhile && state.testedState === "exact reconstructed"
            ? `${state.why}, but another session wrote the commit's lines meanwhile`
            : state.why,
          why,
        ],
        method: CHECKS_METHOD,
      },
    ];
  });
}

/**
 * The checks behind one link. One that names its entries (`entryIds`: `history link --entry`) gets those
 * entries' checks, and evidence linked by turns (a `tested` link to a commit made before) the
 * checks of those turns, whenever they ran; an implemented link gets `checksFor`, cut off at the
 * commit.
 */
export function checksForEvidence(
  input: Parameters<typeof checksFor>[0] & {
    readonly entryIds?: ReadonlyArray<string> | undefined;
    readonly role?: string | undefined;
  },
): Check[] {
  const evidence = !!input.role && input.role !== "implemented";
  if (!input.entryIds?.length && !(evidence && input.turns.length > 0)) return checksFor(input);
  const named = new Set(input.entryIds?.length ? input.entryIds : input.turns);
  return checksFor({
    ...input,
    turns: input.entryIds?.length ? [] : input.turns,
    committedAt: "9999-12-31T23:59:59.999Z",
  }).filter((c) => named.has(input.entryIds?.length ? c.actionId : c.turn));
}
