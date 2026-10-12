// Checkpoints: one session's history taken at a moment (a turn end, a commit, by hand) and kept as
// one JSON document, the `checkpoints` table in Postgres. It holds what a ledger link holds, plus
// what the ledger drops: model, token usage and timing. Built once, from the session as it
// is then, because session stores change and get deleted. Pure, so the CLI and tests share it.
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { Entry, Labels, type Action } from "./domain.ts";
import {
  fileCoverage,
  LEDGER_FORMAT_VERSION,
  LedgerCommit,
  LedgerThread,
  LINK_ROLES,
  LINK_VIA,
  redactLink,
  type LedgerEntry,
  type LedgerLink,
  type LinkRole,
  type LinkVia,
} from "./ledger.ts";
import { redactor, redactText } from "./proof.ts";
import { assignPhases, splitTurns, turnStats } from "./tree.ts";

export const CHECKPOINT_FORMAT_VERSION = 1;
export const CHECKPOINT_TRIGGERS = ["commit", "manual"] as const;
export type CheckpointTrigger = (typeof CHECKPOINT_TRIGGERS)[number];

/** As the provider reported it for one turn: a snapshot of the context window, not a running sum. */
export const TokenUsage = Schema.Struct({
  input: Schema.NullOr(Schema.Number),
  cachedInput: Schema.NullOr(Schema.Number),
  output: Schema.NullOr(Schema.Number),
  reasoning: Schema.NullOr(Schema.Number),
  total: Schema.NullOr(Schema.Number),
});
export type TokenUsage = typeof TokenUsage.Type;

const PHASES = ["explore", "edit", "verify", "fix", "ship"] as const;

/** One turn of the viewer's tree, summarized for queries; `buildTree` rebuilds the rest from `entries`. */
export const CheckpointTurn = Schema.Struct({
  /** The prompt's entry id, as `buildTree` names turns; `turn:<first entry id>` without one. */
  id: Schema.String,
  startedAt: Schema.String,
  endedAt: Schema.String,
  model: Schema.NullOr(Schema.String),
  usage: Schema.NullOr(TokenUsage),
  phases: Schema.Array(
    Schema.Struct({ phase: Schema.Literals(PHASES), actionIds: Schema.Array(Schema.String) }),
  ),
  stats: Schema.Struct({
    actions: Schema.Number,
    failed: Schema.Number,
    files: Schema.Number,
    added: Schema.Number,
    removed: Schema.Number,
  }),
});
export type CheckpointTurn = typeof CheckpointTurn.Type;

/** The commit a commit checkpoint belongs to, and this thread's link to it (as `LedgerLink` has it). */
export const CheckpointCommit = Schema.Struct({
  ...LedgerCommit.fields,
  role: Schema.Literals(LINK_ROLES),
  via: Schema.Literals(LINK_VIA),
  reviewedSha: Schema.NullOr(Schema.String),
  /** Every file the commit changed. */
  paths: Schema.Array(Schema.String),
  /** The ones this thread edited. */
  files: Schema.Array(Schema.String),
});
export type CheckpointCommit = typeof CheckpointCommit.Type;

export const CheckpointV1 = Schema.Struct({
  formatVersion: Schema.Literal(1),
  /** `checkpointKey`: the same moment of the same thread always gets the same id. */
  id: Schema.String,
  trigger: Schema.Literals(CHECKPOINT_TRIGGERS),
  takenAt: Schema.String,
  toolreaderVersion: Schema.String,
  /** The provider's session as agents name it (`codex:<id>`, `claude-code:<id>`), when known. */
  session: Schema.NullOr(Schema.String),
  thread: LedgerThread,
  repo: Schema.Struct({
    /** The origin remote's owner/name, else the directory name. */
    name: Schema.String,
    worktree: Schema.NullOr(Schema.String),
    branch: Schema.NullOr(Schema.String),
    head: Schema.NullOr(Schema.String),
  }),
  commit: Schema.NullOr(CheckpointCommit),
  outputs: Schema.Literals(["included", "omitted"]),
  redactions: Schema.Number,
  /** Redacted and clipped exactly like a ledger link's. */
  entries: Schema.Array(Entry),
  labels: Labels,
  turns: Schema.Array(CheckpointTurn),
  filesTouched: Schema.Array(
    Schema.Struct({ path: Schema.String, added: Schema.Number, removed: Schema.Number }),
  ),
  durationMs: Schema.NullOr(Schema.Number),
});
export type CheckpointV1 = typeof CheckpointV1.Type;

/**
 * Every stored version. A v2 joins this union, with a transformation from v1
 * to the newest shape, as `LedgerEntry` reads v1 entries.
 */
export const Checkpoint = Schema.Union([CheckpointV1]);
export type Checkpoint = CheckpointV1;

const FormatProbe = Schema.Struct({ formatVersion: Schema.Number });
const decodeFormat = Schema.decodeUnknownOption(FormatProbe);
const decodeStored = Schema.decodeUnknownResult(Checkpoint);

/**
 * A stored payload as this toolreader reads it. A format newer than it knows (a newer toolreader
 * wrote it) is refused by name, so the message says to upgrade rather than dump the schema.
 */
export function readCheckpoint(payload: unknown): Result.Result<Checkpoint, string> {
  const format = Option.getOrNull(decodeFormat(payload))?.formatVersion ?? null;
  if (format !== null && format > CHECKPOINT_FORMAT_VERSION)
    return Result.fail(
      `checkpoint format v${format} is newer than this toolreader reads (v${CHECKPOINT_FORMAT_VERSION}): upgrade toolreader`,
    );
  return Result.mapError(decodeStored(payload), (e) => `not a checkpoint: ${e.message}`);
}

export const REJECT_REASONS = [
  "unsupported-format",
  "invalid",
  "key-mismatch",
  "not-redacted",
  "too-large",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

const standardCheckpoint = Schema.toStandardSchemaV1(Checkpoint);

/**
 * A field path safe to send back: indexes and schema field names (camelCase letters) as they
 * are; record keys (label ids, which could be anything a session wrote) as `*`.
 */
const safePath = (path: ReadonlyArray<PropertyKey>) =>
  path
    .map((p, i) =>
      // `labels` is the record's one map: every key under it is a label id, whatever it spells.
      typeof p === "number" ||
      (typeof p === "string" && /^[a-z][A-Za-z]*$/.test(p) && !(i === 1 && path[0] === "labels"))
        ? p
        : "*",
    )
    .join(".") || "(record)";

/**
 * The first leaf or record key in `value` that `bad` flags, as a safe path; null when none.
 * Keys count: a label's key is session text as much as its value.
 */
function firstField(
  value: unknown,
  bad: (leaf: unknown) => boolean,
  path: ReadonlyArray<string | number> = [],
): string | null {
  if (value === null || typeof value !== "object") return bad(value) ? safePath(path) : null;
  for (const [key, v] of Object.entries(value)) {
    const at = [...path, Array.isArray(value) ? Number(key) : key];
    if (!Array.isArray(value) && bad(key)) return safePath(at);
    const found = firstField(v, bad, at);
    if (found !== null) return found;
  }
  return null;
}

const redacts = (leaf: unknown) => typeof leaf === "string" && redactText(leaf).text !== leaf;
/** JSON's `1e400` parses as Infinity, which Schema.Number takes and jsonb can't hold. */
const nonFinite = (leaf: unknown) => typeof leaf === "number" && !Number.isFinite(leaf);

/** As `buildCheckpoint` writes it (`DateTime.formatIso`), and as Postgres' timestamptz takes it. */
const ISO_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;

/** An ISO time whose every part exists (no February 30, no year 0, no hour 24). */
function isIsoTime(s: string): boolean {
  const m = ISO_TIME.exec(s);
  if (!m) return false;
  const [year, month, day, hour, minute, second, offsetHour = 0, offsetMinute = 0] = m
    .slice(1)
    .map((x) => (x === undefined ? undefined : Number(x)));
  const leap = year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month! - 1];
  return (
    year! >= 1 &&
    days !== undefined &&
    day! >= 1 &&
    day! <= days &&
    hour! < 24 &&
    minute! < 60 &&
    second! < 60 &&
    offsetHour < 16 &&
    offsetMinute < 60
  );
}

/**
 * Whether a record someone sent may be stored, as the backend checks each one: a format it knows,
 * a valid record of it, the id `checkpointKey` gives it, and no text the redactor would still
 * change. `detail` names fields and versions only, never the record's text.
 */
export function admitCheckpoint(
  record: unknown,
): Result.Result<Checkpoint, { readonly reason: RejectReason; readonly detail: string }> {
  const format = Option.getOrNull(decodeFormat(record))?.formatVersion ?? null;
  if (format === null)
    return Result.fail({ reason: "invalid", detail: "formatVersion is missing or not a number" });
  if (format !== CHECKPOINT_FORMAT_VERSION)
    return Result.fail({
      reason: "unsupported-format",
      detail: `checkpoint format v${format}; this backend takes v${CHECKPOINT_FORMAT_VERSION}`,
    });
  const decoded = standardCheckpoint["~standard"].validate(record);
  if (decoded instanceof Promise || decoded.issues !== undefined) {
    const at = decoded instanceof Promise ? [] : (decoded.issues[0]?.path ?? []);
    const path = safePath(at.map((p) => (typeof p === "object" ? p.key : p)));
    return Result.fail({
      reason: "invalid",
      detail: `not a checkpoint v1 at ${path}`,
    });
  }
  const checkpoint = decoded.value;
  const infinite = firstField(checkpoint, nonFinite);
  if (infinite !== null)
    return Result.fail({ reason: "invalid", detail: `not a finite number at ${infinite}` });
  // Postgres text refuses NUL; the payload escapes it, the id column can't.
  if (checkpoint.id.includes("\u0000"))
    return Result.fail({ reason: "invalid", detail: "id holds a NUL character" });
  // As `:repo` takes it (`backendApi.ts`): a longer one would be stored and never found.
  if (checkpoint.repo.name.length > 512)
    return Result.fail({ reason: "invalid", detail: "repo.name is over 512 characters" });
  if (!isIsoTime(checkpoint.takenAt))
    return Result.fail({ reason: "invalid", detail: "takenAt is not an ISO 8601 time" });
  if ((checkpoint.trigger === "commit") !== (checkpoint.commit !== null))
    return Result.fail({
      reason: "invalid",
      detail: "commit is set exactly when trigger is commit",
    });
  const key = checkpointKey({
    trigger: checkpoint.trigger,
    threadId: checkpoint.thread.id,
    repo: checkpoint.repo.name,
    commit: checkpoint.commit && { sha: checkpoint.commit.sha, role: checkpoint.commit.role },
    entries: checkpoint.entries,
  });
  if (key !== checkpoint.id)
    return Result.fail({ reason: "key-mismatch", detail: "id is not the record's checkpointKey" });
  const field = firstField(checkpoint, redacts);
  if (field !== null)
    return Result.fail({ reason: "not-redacted", detail: `the redactor would change ${field}` });
  return Result.succeed(checkpoint);
}

/** Per-turn facts a reader found besides the entries; joined to turns by the prompt's entry id. */
export type TurnMeta = {
  readonly promptId: string;
  readonly model: string | null;
  readonly usage: TokenUsage | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
};

const turnId = (prompt: Entry | null, entries: ReadonlyArray<Entry>) =>
  prompt?.id ?? `turn:${entries[0]?.id ?? ""}`;

/** The same moment of the same thread always gets the same key: re-runs write nothing new. */
export function checkpointKey(input: {
  readonly trigger: CheckpointTrigger;
  readonly threadId: string;
  readonly repo: string;
  readonly commit: { readonly sha: string; readonly role: LinkRole } | null;
  readonly entries: ReadonlyArray<Entry>;
}): string {
  switch (input.trigger) {
    case "commit":
      return `commit:${input.repo}:${input.commit?.sha ?? ""}:${input.threadId}:${input.commit?.role ?? ""}`;
    case "manual":
      return `manual:${input.threadId}:${input.entries.at(-1)?.id ?? ""}`;
  }
}

function checkpointTurns(
  entries: ReadonlyArray<Entry>,
  meta: ReadonlyMap<string, TurnMeta>,
  clean: (s: string) => string,
): CheckpointTurn[] {
  return splitTurns(entries).map((turn) => {
    const actions = turn.entries.filter((e): e is Action => e.type === "action");
    const phaseOf = assignPhases(actions);
    const phases: Array<{ phase: (typeof PHASES)[number]; actionIds: string[] }> = [];
    for (const a of actions) {
      const phase = phaseOf.get(a.id) ?? "explore";
      if (phase === "all") continue;
      const last = phases.at(-1);
      if (last?.phase === phase) last.actionIds.push(a.id);
      else phases.push({ phase, actionIds: [a.id] });
    }
    const { start, end, ...stats } = turnStats(actions, turn.prompt, turn.entries);
    const id = turnId(turn.prompt, turn.entries);
    const m = meta.get(id);
    return {
      id,
      startedAt: m?.startedAt ?? start,
      endedAt: m?.endedAt ?? end,
      model: m?.model ? clean(m.model) : null,
      usage: m?.usage ?? null,
      phases,
      stats,
    };
  });
}

function filesTouched(entries: ReadonlyArray<Entry>): CheckpointV1["filesTouched"] {
  const files = new Map<string, { added: number; removed: number }>();
  for (const e of entries)
    if (e.type === "action" && e.status !== "failed")
      for (const f of e.files ?? []) {
        const s = files.get(f.path) ?? { added: 0, removed: 0 };
        s.added += f.added;
        s.removed += f.removed;
        files.set(f.path, s);
      }
  return [...files].map(([path, s]) => ({ path, ...s }));
}

/**
 * The checkpoint for `segment`: redacted through the ledger's own `redactLink` (entries, title,
 * labels), every other text (commit subject and paths, repo name and branch, models) cleaned
 * with the same redactor, and turns summarized.
 */
export function buildCheckpoint(input: {
  readonly trigger: CheckpointTrigger;
  readonly takenAt: string;
  readonly toolreaderVersion: string;
  readonly session: string | null;
  readonly thread: LedgerThread;
  readonly repo: CheckpointV1["repo"];
  readonly commit: {
    readonly commit: LedgerCommit;
    readonly role: LinkRole;
    readonly via: LinkVia;
    readonly reviewedSha: string | null;
    readonly paths: ReadonlyArray<string>;
  } | null;
  readonly segment: ReadonlyArray<Entry>;
  readonly labels: Labels;
  readonly turnMeta: ReadonlyArray<TurnMeta>;
  readonly outputs: boolean;
  readonly maxOutput: number;
  readonly roots?: ReadonlyArray<string> | undefined;
  readonly home?: string | undefined;
}): CheckpointV1 {
  const { clean, count } = redactor(input.home);
  const { link, redactions } = redactLink(
    {
      thread: input.thread,
      role: input.commit?.role ?? "coder",
      via: input.commit?.via ?? "session",
      reviewedSha: input.commit?.reviewedSha ?? null,
      segment: input.segment,
      labels: input.labels,
    },
    {
      paths: input.commit?.paths ?? [],
      roots: input.roots,
      outputs: input.outputs,
      maxOutput: input.maxOutput,
      home: input.home,
    },
    clean,
  );
  const commit = input.commit && {
    ...input.commit.commit,
    subject: clean(input.commit.commit.subject),
    role: input.commit.role,
    via: input.commit.via,
    reviewedSha: input.commit.reviewedSha,
    paths: input.commit.paths.map(clean),
    files: link.files.map(clean),
  };
  const repo = {
    name: clean(input.repo.name),
    worktree: input.repo.worktree && clean(input.repo.worktree),
    branch: input.repo.branch && clean(input.repo.branch),
    head: input.repo.head,
  };
  const thread = {
    ...link.thread,
    origin: link.thread.origin && clean(link.thread.origin),
    provider: link.thread.provider && clean(link.thread.provider),
  };
  // Built before `count()` is read: model names are cleaned here too.
  const turns = checkpointTurns(
    link.entries,
    new Map(input.turnMeta.map((m) => [m.promptId, m])),
    clean,
  );
  const first = link.entries[0]?.at;
  const last = link.entries.at(-1)?.at;
  return {
    formatVersion: CHECKPOINT_FORMAT_VERSION,
    id: checkpointKey({
      trigger: input.trigger,
      threadId: input.thread.id,
      repo: repo.name,
      commit: commit && { sha: commit.sha, role: commit.role },
      entries: link.entries,
    }),
    trigger: input.trigger,
    takenAt: input.takenAt,
    toolreaderVersion: input.toolreaderVersion,
    session: input.session && clean(input.session),
    thread,
    repo,
    commit,
    outputs: input.outputs ? "included" : "omitted",
    redactions: redactions + count(),
    entries: link.entries,
    labels: link.labels,
    turns,
    filesTouched: filesTouched(link.entries),
    durationMs: first && last ? Date.parse(last) - Date.parse(first) : null,
  };
}

/**
 * The ledger entry of `target`, from the commit checkpoints found for it (one per thread and role,
 * the commit's own or an older SHA's it was rewritten from): what `ledger sync` would write,
 * without tokens or turn summaries. A thread and role found twice keeps the first.
 */
export function toLedgerEntry(
  target: { readonly commit: LedgerCommit; readonly paths: ReadonlyArray<string> },
  checkpoints: ReadonlyArray<Checkpoint>,
): LedgerEntry {
  const seen = new Set<string>();
  const mine = checkpoints.filter((c) => {
    const key = c.commit && `${c.thread.id}\u0000${c.commit.role}`;
    return key !== null && !seen.has(key) && (seen.add(key), true);
  });
  const links = mine.map(
    (c): LedgerLink => ({
      thread: c.thread,
      role: c.commit!.role,
      via: c.commit!.via,
      reviewedSha: c.commit!.reviewedSha,
      files: c.commit!.files,
      entries: c.entries,
      labels: c.labels,
    }),
  );
  // Cleaned like the checkpoints' own copies, so coverage compares like with like; their secrets
  // were counted when the checkpoints were taken.
  const { clean } = redactor();
  const paths = target.paths.map(clean);
  return {
    formatVersion: LEDGER_FORMAT_VERSION,
    commit: { ...target.commit, subject: clean(target.commit.subject) },
    links,
    unlinked: [],
    files: fileCoverage(paths, links),
    notes: [],
    outputs: mine.every((c) => c.outputs === "included") ? "included" : "omitted",
    redactions: mine.reduce((n, c) => n + c.redactions, 0),
  };
}
