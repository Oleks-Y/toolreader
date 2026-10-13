// Experimental per-hunk blame (scripts/blameEval.ts): for each hunk of a commit's diff, which
// pieces (actions) of the threads already linked to it (core/history.ts) produced it. Code only
// scopes and shapes the evidence; TypeSafe's Jev judges each (hunk, piece) pair, so a lockfile
// changed by `pnpm add`, a `sed -i` and a script the agent ran are judged like a direct edit.
// Pure: the script reads git, the sessions and the API.
import * as Schema from "effect/Schema";

import { Entry, type Action } from "./domain.ts";
import { turnId } from "./history.ts";
import { splitTurns } from "./tree.ts";

/** Pinned, so answers stay comparable across runs; move it only with retuned thresholds. */
export const BLAME_MODEL = "jev-1.13.0";

/** One `@@` hunk of a commit's diff. */
export type Hunk = {
  readonly id: string;
  readonly path: string;
  readonly header: string;
  /** The hunk's lines, `+`/`-`/context, as git printed them. */
  readonly text: string;
};

/** The hunks of `git diff-tree -p` output, ids `H1…` in order. Binary files have none. */
export function hunksOf(diff: string): Hunk[] {
  const hunks: Array<{ path: string; header: string; lines: string[] }> = [];
  let from = "";
  let path = "";
  let current: { path: string; header: string; lines: string[] } | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = null;
      from = path = "";
    } else if (!current && line.startsWith("--- ")) from = line.slice(4).replace(/^a\//, "");
    else if (!current && line.startsWith("+++ ")) {
      const to = line.slice(4).replace(/^b\//, "");
      path = to === "/dev/null" ? from : to;
    } else if (line.startsWith("@@") && path) {
      current = { path, header: line, lines: [] };
      hunks.push(current);
    } else if (current && /^[ +\-\\]/.test(line)) current.lines.push(line);
  }
  return hunks.map((h, i) => ({
    id: `H${i + 1}`,
    path: h.path,
    header: h.header,
    text: h.lines.join("\n"),
  }));
}

/**
 * Whether `hunk` changes line `line` of `path` as the commit has it (the `+c,d` side of its
 * header). A hunk that only removes lines covers the line it removed them before.
 */
export function covers(hunk: Hunk, path: string, line: number): boolean {
  const m = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(hunk.header);
  if (!m || hunk.path !== path) return false;
  const start = Number(m[1]);
  const count = m[2] === undefined ? 1 : Number(m[2]);
  return line >= start && line < start + Math.max(count, 1);
}

/** A candidate cause: an action of a linked turn, in the order the thread ran it. */
export type Piece = { readonly id: string; readonly threadId: string; readonly action: Action };

/** Kinds that can't change a file. */
const READ_ONLY = new Set(["read", "search", "web"]);

/** Ignores clock skew between the agent's machine and the committer's (as history.ts does). */
const CLOCK_SKEW_MS = 2_000;

/**
 * The pieces of a commit's linked threads: actions of the linked turns (every turn when a link
 * names none, e.g. a trailer) that ran before the commit and could change files, in the order
 * they ran. Ids `A01…`.
 */
export function piecesOf(
  links: ReadonlyArray<{ readonly threadId: string; readonly turns: ReadonlyArray<string> }>,
  entriesOf: (threadId: string) => ReadonlyArray<Entry> | undefined,
  committedAt: string,
): Piece[] {
  const until = Date.parse(committedAt) + CLOCK_SKEW_MS;
  const actions: Array<{ threadId: string; action: Action }> = [];
  for (const link of links) {
    const turns = new Set(link.turns);
    for (const t of splitTurns(entriesOf(link.threadId) ?? []))
      if (turns.size === 0 || turns.has(turnId(t.prompt, t.entries)))
        for (const e of t.entries)
          if (e.type === "action" && !READ_ONLY.has(e.kind) && Date.parse(e.at) <= until)
            actions.push({ threadId: link.threadId, action: e });
  }
  // In time order across threads, so the last writer is the latest piece.
  actions.sort((a, b) => Date.parse(a.action.at) - Date.parse(b.action.at));
  return actions.map((a, i) => ({ id: `A${String(i + 1).padStart(2, "0")}`, ...a }));
}

export type BlameLimits = {
  /** Bytes of the hunk sent; a lockfile rewrite needs its shape, not every line. */
  readonly hunkBytes: number;
  /** Bytes of an edit's diff of the hunk's own file. */
  readonly diffBytes: number;
  /** Bytes of the command of a piece that names the file: a script's text is its only diff. */
  readonly commandBytes: number;
  /** Bytes of a command's output, from the head. */
  readonly outputBytes: number;
  /** Bytes of the command of a piece that doesn't name the file: `pnpm add x` fits. */
  readonly briefBytes: number;
  /** Pieces per request: a Choice takes 255 options, one is `none`. */
  readonly maxPieces: number;
};

export const DEFAULT_LIMITS: BlameLimits = {
  hunkBytes: 6_000,
  diffBytes: 2_000,
  commandBytes: 3_000,
  outputBytes: 300,
  briefBytes: 160,
  maxPieces: 120,
};

/** Kinds whose effect on a file needn't show in their text: installs, builds, scripts. */
const INDIRECT = new Set(["setup", "build", "run", "tool", "agent", "test"]);

const cut = (text: string, bytes: number) =>
  text.length <= bytes ? text : `${text.slice(0, bytes)}\n… (${text.length - bytes} more chars)`;

/** The part of a hunk within `radius` lines of its new-side `line`, as a hunk of its own. */
export function around(
  hunk: { header: string; text: string },
  line: number,
  radius = 5,
): { header: string; text: string } {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(hunk.header);
  if (!m) return hunk;
  let [oldNo, newNo] = [Number(m[1]), Number(m[2])];
  let [oldStart, newStart, oldCount, newCount] = [0, 0, 0, 0];
  const kept: string[] = [];
  for (const l of hunk.text.split("\n")) {
    const counts = { old: l[0] !== "+" && l[0] !== "\\", new: l[0] !== "-" && l[0] !== "\\" };
    // A removed line sits where the next new line is.
    if (Math.abs(newNo - line) <= radius) {
      if (kept.length === 0) [oldStart, newStart] = [oldNo, newNo];
      kept.push(l);
      if (counts.old) oldCount++;
      if (counts.new) newCount++;
    }
    if (counts.old) oldNo++;
    if (counts.new) newNo++;
  }
  if (kept.length === 0) return hunk;
  return {
    header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    text: kept.join("\n"),
  };
}

/** Whether an action names the file in its paths, command or title: the blame page shows these. */
export const namesFile = (a: Action, path: string) => {
  const base = path.split("/").pop() ?? path;
  return [a.title, a.command ?? "", ...(a.files ?? []).map((f) => f.path)].some((s) =>
    s.includes(base),
  );
};

/** Whether a piece names the file, its output included. */
const mentions = (a: Action, path: string) =>
  namesFile(a, path) || (a.output ?? "").includes(path.split("/").pop() ?? path);

/**
 * A piece's part in a hunk. Only `wrote` is blame: staging, committing and checking touch the
 * lines without writing them, and a yes/no question let them through.
 */
const ROLES = {
  wrote:
    "Wrote, changed or removed some of these lines: an edit that shows them; a command or script that generated, installed or rewrote this content in this file; or a formatter or fixer (fmt, prettier, eslint --fix, vp check --fix) run over this file or a directory holding it, which rewraps or reorders lines an edit wrote",
  staged:
    "Only staged, committed, stashed or pushed the change (git add, git commit); it wrote none of the lines",
  checked:
    "Only read the file, searched it, or ran tests, type checks or linters that report without rewriting files",
  unrelated: "Worked on other files or other lines, or did something unrelated to these lines",
} as const;
export type Role = keyof typeof ROLES;

type Json = string | number | boolean | null | { [k: string]: Json } | Json[];
type Question = {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string | null>>;
};

export type BlameRequest = {
  readonly body: {
    readonly model: string;
    readonly state: Json;
    readonly questions: Record<string, Question>;
  };
  /** The pieces asked about, in state order; `body.state.actions[i]` is `asked[i]`. */
  readonly asked: ReadonlyArray<Piece>;
  /** Pieces left out to stay under `maxPieces` (those naming neither the file nor run indirectly). */
  readonly dropped: number;
  readonly stateBytes: number;
};

/**
 * One request for one hunk: the hunk and the pieces as state, one Choice per piece (its role in
 * the hunk, `ROLES`) and one Choice for the piece most responsible. `clean` redacts every string
 * that leaves the machine (secrets, home, worktree roots).
 */
export function buildRequest(
  input: { readonly subject: string; readonly hunk: Hunk; readonly pieces: ReadonlyArray<Piece> },
  clean: (text: string) => string,
  limits: BlameLimits = DEFAULT_LIMITS,
  model = BLAME_MODEL,
): BlameRequest {
  const { hunk } = input;
  let asked = input.pieces;
  if (asked.length > limits.maxPieces)
    asked = asked.filter((p) => mentions(p.action, hunk.path) || INDIRECT.has(p.action.kind));
  // ponytail: keeps the latest when still too many; window in two passes if real turns hit this.
  asked = asked.slice(-limits.maxPieces);
  const state = {
    commit: clean(input.subject),
    file: clean(hunk.path),
    hunk: clean(cut(`${hunk.header}\n${hunk.text}`, limits.hunkBytes)),
    actions: asked.map(({ id, action: a }, i) => {
      const piece: Record<string, Json> = {
        id,
        step: `${i + 1} of ${asked.length}`,
        kind: a.kind,
        status: a.status,
        what: clean(a.title),
      };
      if (a.hint) piece.intent = clean(a.hint);
      // Pieces that don't name the file go in brief: most of a long turn, and noise to the model.
      if (!mentions(a, hunk.path)) {
        if (a.command) piece.command = clean(cut(a.command, limits.briefBytes));
        return piece;
      }
      const own = a.files?.find((f) => f.path === hunk.path || f.path.endsWith(`/${hunk.path}`));
      if (a.command) piece.command = clean(cut(a.command, limits.commandBytes));
      if (a.files?.length) piece.files = a.files.map((f) => clean(f.path));
      if (own?.diff) piece.diff = clean(cut(own.diff, limits.diffBytes));
      if (a.output && a.kind !== "edit") piece.output = clean(cut(a.output, limits.outputBytes));
      return piece;
    }),
  };
  const questions: Record<string, Question> = {};
  asked.forEach((p, i) => {
    questions[p.id] = {
      type: "choice",
      instructions: `What did the action \`actions[${i}]\` (id ${p.id}) do to the lines marked + or - in \`hunk\` of \`file\`?`,
      criteria: ROLES,
    };
  });
  questions.main = {
    type: "choice",
    instructions:
      "Which action in `actions` is most responsible for the changes (lines marked + or -) in `hunk` of `file`?",
    criteria: {
      ...Object.fromEntries(asked.map((p) => [p.id, null])),
      none: "No listed action produced these changes: a person wrote them, or a tool that isn't listed",
    },
  };
  return {
    body: { model, state, questions },
    asked,
    dropped: input.pieces.length - asked.length,
    stateBytes: JSON.stringify(state).length,
  };
}

const ChoiceAnswer = Schema.Struct({
  type: Schema.Literal("choice"),
  choice: Schema.String,
  probabilities: Schema.Record(Schema.String, Schema.Number),
  confidence: Schema.Number,
});
export const SystemOneResponse = Schema.Struct({
  model: Schema.String,
  answers: Schema.Record(Schema.String, ChoiceAnswer),
  usage: Schema.Struct({
    input_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
    output_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  }),
});
export type SystemOneResponse = typeof SystemOneResponse.Type;

export type Thresholds = { readonly by: number; readonly possibly: number };
export const DEFAULT_THRESHOLDS: Thresholds = { by: 0.8, possibly: 0.3 };

export type HunkBlame =
  | { readonly status: "unavailable"; readonly reason: string }
  | {
      readonly status: "attributed" | "possibly" | "none";
      /** Pieces whose P(wrote) reached `by`, and those that reached `possibly`; in run order. */
      readonly by: ReadonlyArray<{ readonly id: string; readonly p: number }>;
      readonly possibly: ReadonlyArray<{ readonly id: string; readonly p: number }>;
      /** Pieces Jev says touched the lines without writing them (`staged`, `checked`). */
      readonly touched: ReadonlyArray<{
        readonly id: string;
        readonly role: Role;
        readonly p: number;
      }>;
      readonly main: { readonly id: string; readonly p: number; readonly confidence: number };
      readonly model: string;
      readonly inputTokens: number;
    };

/** A hunk's blame from the answers; a missing or mistyped answer makes it unavailable. */
export function readBlame(
  request: Pick<BlameRequest, "asked">,
  response: SystemOneResponse,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): HunkBlame {
  const ps: Array<{ id: string; p: number; role: Role; rp: number }> = [];
  for (const { id } of request.asked) {
    const a = response.answers[id];
    if (a?.type !== "choice" || !(a.choice in ROLES))
      return { status: "unavailable", reason: `no answer for ${id}` };
    const role = a.choice as Role;
    ps.push({ id, p: a.probabilities.wrote ?? 0, role, rp: a.probabilities[role] ?? 0 });
  }
  const main = response.answers.main;
  if (main?.type !== "choice") return { status: "unavailable", reason: "no answer for main" };
  const by = ps.filter((x) => x.p >= thresholds.by).map(({ id, p }) => ({ id, p }));
  const possibly = ps
    .filter((x) => x.p >= thresholds.possibly && x.p < thresholds.by)
    .map(({ id, p }) => ({ id, p }));
  const touched = ps
    .filter((x) => x.p < thresholds.possibly && (x.role === "staged" || x.role === "checked"))
    .map(({ id, role, rp }) => ({ id, role, p: rp }));
  return {
    status: by.length > 0 ? "attributed" : possibly.length > 0 ? "possibly" : "none",
    by,
    possibly,
    touched,
    main: {
      id: main.choice,
      p: main.probabilities[main.choice] ?? 0,
      confidence: main.confidence,
    },
    model: response.model,
    inputTokens: response.usage.input_tokens ?? 0,
  };
}

/**
 * A line as GitHub links it from a diff: a PR's (`/pull/7/files`, `/pull/7/changes`) or a
 * commit's, anchored `#diff-<sha256 of the path>R<line>` (`R`: the new side, `L`: the old).
 */
export type LineLink = {
  /** `https://github.com/owner/name`. */
  readonly repoUrl: string;
  readonly pr: number | null;
  readonly sha: string | null;
  readonly fileHash: string;
  readonly side: "R" | "L";
  readonly line: number;
};

const LINE_LINK =
  /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull\/(\d+)(?:\/[\w./-]*)?|commit\/([0-9a-f]{7,64}))\/?#diff-([0-9a-f]{64})([RL])(\d+)(?:-[RL]\d+)?$/;

export function parseLineLink(url: string): LineLink | null {
  const m = LINE_LINK.exec(url.trim());
  if (!m) return null;
  return {
    repoUrl: `https://github.com/${m[1]}/${m[2]}`,
    pr: m[3] ? Number(m[3]) : null,
    sha: m[4] ?? null,
    fileHash: m[5]!,
    side: m[6] as "R" | "L",
    line: Number(m[7]),
  };
}

/** Jev's probability for each role of a piece in the hunk. */
export const RoleOdds = Schema.Struct({
  wrote: Schema.Number,
  staged: Schema.Number,
  checked: Schema.Number,
  unrelated: Schema.Number,
});
export type RoleOdds = typeof RoleOdds.Type;

export const BlamePiece = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  actionId: Schema.String,
  odds: RoleOdds,
});
export type BlamePiece = typeof BlamePiece.Type;

/** What `/api/blame` answers: the raw judgments, so the page applies its own policy. */
export const BlameResult = Schema.Struct({
  repoUrl: Schema.String,
  commit: Schema.Struct({ sha: Schema.String, subject: Schema.String, committedAt: Schema.String }),
  /** The line as the blamed commit has it. */
  path: Schema.String,
  line: Schema.Number,
  hunk: Schema.Struct({ header: Schema.String, text: Schema.String }),
  /** The commit's linked threads, whole; their entries hold the pieces' actions. */
  threads: Schema.Array(
    Schema.Struct({ id: Schema.String, title: Schema.String, entries: Schema.Array(Entry) }),
  ),
  pieces: Schema.Array(BlamePiece),
  /** The piece Jev holds most responsible, or `none`. */
  main: Schema.Struct({ id: Schema.String, p: Schema.Number }),
  model: Schema.String,
  inputTokens: Schema.Number,
});
export type BlameResult = typeof BlameResult.Type;

/** Each asked piece's role odds and the main pick; null when an answer is missing. */
export function oddsOf(
  request: Pick<BlameRequest, "asked">,
  response: SystemOneResponse,
): { pieces: BlamePiece[]; main: { id: string; p: number } } | null {
  const pieces: BlamePiece[] = [];
  for (const { id, threadId, action } of request.asked) {
    const a = response.answers[id];
    if (a?.type !== "choice") return null;
    const p = (role: Role) => a.probabilities[role] ?? 0;
    pieces.push({
      id,
      threadId,
      actionId: action.id,
      odds: {
        wrote: p("wrote"),
        staged: p("staged"),
        checked: p("checked"),
        unrelated: p("unrelated"),
      },
    });
  }
  const main = response.answers.main;
  if (main?.type !== "choice") return null;
  return { pieces, main: { id: main.choice, p: main.probabilities[main.choice] ?? 0 } };
}

/** Why the blame page shows an action: Jev's role for it, or that it names the file. */
export type Mark = { tone: "wrote" | "maybe" | "touched"; why: string };
export function marksOf(
  result: Pick<BlameResult, "pieces" | "threads" | "path">,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): Map<string, Mark> {
  const marks = new Map<string, Mark>();
  for (const { actionId, odds } of result.pieces) {
    const p = odds.wrote.toFixed(2);
    if (odds.wrote >= thresholds.by) marks.set(actionId, { tone: "wrote", why: `wrote ${p}` });
    else if (odds.wrote >= thresholds.possibly)
      marks.set(actionId, { tone: "maybe", why: `wrote? ${p}` });
    else if (odds.staged >= 0.5) marks.set(actionId, { tone: "touched", why: "staged it" });
    else if (odds.checked >= 0.5) marks.set(actionId, { tone: "touched", why: "checked it" });
  }
  for (const t of result.threads)
    for (const e of t.entries)
      if (e.type === "action" && !marks.has(e.id) && namesFile(e, result.path))
        marks.set(e.id, { tone: "touched", why: "names file" });
  return marks;
}
