import * as Schema from "effect/Schema";

/** What an action does. Shell commands are classified by intent (setup/build/run/test), not toolchain. */
export const ACTION_KINDS = [
  "read",
  "search",
  "edit",
  "git",
  "docker",
  "setup",
  "build",
  "run",
  "test",
  "web",
  "tool",
  "agent",
] as const;
export const ActionKind = Schema.Literals(ACTION_KINDS);
export type ActionKind = typeof ActionKind.Type;

export const FileChange = Schema.Struct({
  path: Schema.String,
  added: Schema.Number,
  removed: Schema.Number,
  isNew: Schema.Boolean,
  isDeleted: Schema.Boolean,
  /** Unified diff hunks (`@@ -a,b +c,d @@` …), whole hunks only. */
  diff: Schema.optional(Schema.String),
  /** Hunks were dropped to keep the payload small. */
  truncated: Schema.optional(Schema.Boolean),
  /**
   * With `truncated`: every added line of the whole diff worth matching (history.ts
   * `addedLines`), so `linkByContent` still finds what a big write added.
   */
  addedKeys: Schema.optional(Schema.Array(Schema.String)),
  /** Line numbers are real file lines (Codex). Claude/Cursor edits only know the edited snippet. */
  exactLines: Schema.optional(Schema.Boolean),
});
export type FileChange = typeof FileChange.Type;

/**
 * An image a tool returned (a screenshot the agent looked at). On this machine it carries `data`
 * (base64); what leaves it carries only `sha256` and `bytes`, the bytes going to the backend's
 * media bucket when the workspace keeps media (server/backend/MediaBucket.ts).
 */
export const Media = Schema.Struct({
  mime: Schema.String,
  data: Schema.optional(Schema.String),
  sha256: Schema.optional(Schema.String),
  bytes: Schema.optional(Schema.Number),
});
export type Media = typeof Media.Type;

export const Action = Schema.Struct({
  type: Schema.Literal("action"),
  id: Schema.String,
  at: Schema.String,
  kind: ActionKind,
  /** `unknown`: it ran, but its exit code was not recorded (code-mode scripts that print only output). */
  status: Schema.Literals(["ok", "failed", "running", "unknown"]),
  /** Humanized one-liner, e.g. `read src/x.ts:1-40 · search "foo" in src`. */
  title: Schema.String,
  /** Agent-provided intent, e.g. Claude Bash `description`. */
  hint: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Number),
  output: Schema.optional(Schema.String),
  /** Bytes cut from the middle of `output` (ledger `--max-output`). */
  clipped: Schema.optional(Schema.Number),
  files: Schema.optional(Schema.Array(FileChange)),
  /** Each command of a shell chain with its own kind, for per-command coloring. */
  parts: Schema.optional(Schema.Array(Schema.Struct({ kind: ActionKind, title: Schema.String }))),
  /** Read/search targets, used to summarize folded groups. */
  targets: Schema.optional(Schema.Array(Schema.String)),
  /** Search with no matches: not a failure. */
  noMatch: Schema.optional(Schema.Boolean),
  /** Images the tool returned. */
  media: Schema.optional(Schema.Array(Media)),
});
export type Action = typeof Action.Type;

export const Message = Schema.Struct({
  type: Schema.Literal("message"),
  id: Schema.String,
  at: Schema.String,
  role: Schema.Literals(["user", "assistant", "reasoning"]),
  text: Schema.String,
});
export type Message = typeof Message.Type;

export const Event = Schema.Struct({
  type: Schema.Literal("event"),
  id: Schema.String,
  at: Schema.String,
  tone: Schema.Literals(["error", "info"]),
  text: Schema.String,
});
export type Event = typeof Event.Type;

export const Entry = Schema.Union([Action, Message, Event]);
export type Entry = typeof Entry.Type;

export const ThreadStatus = Schema.Literals(["running", "idle", "error"]);
export type ThreadStatus = typeof ThreadStatus.Type;

export const ThreadSource = Schema.Literals(["t3", "codex", "claude"]);
export type ThreadSource = typeof ThreadSource.Type;

export const ThreadSummary = Schema.Struct({
  /** T3 thread ids are bare; other sources are namespaced, e.g. `codex:<threadId>`. */
  id: Schema.String,
  source: ThreadSource,
  /** Which client started the session, e.g. "Codex Desktop", "codex-tui", "codex_exec". */
  origin: Schema.NullOr(Schema.String),
  title: Schema.String,
  projectId: Schema.String,
  projectTitle: Schema.String,
  provider: Schema.NullOr(Schema.String),
  status: ThreadStatus,
  archived: Schema.Boolean,
  updatedAt: Schema.String,
  /** Null when unknown without reading the whole session (Codex). */
  actionCount: Schema.NullOr(Schema.Number),
  /** Directory the agent worked in (T3 worktree or project root, Codex cwd). */
  worktree: Schema.NullOr(Schema.String),
});
export type ThreadSummary = typeof ThreadSummary.Type;

export const Labels = Schema.Record(Schema.String, Schema.String);
export type Labels = typeof Labels.Type;

export const ThreadHead = Schema.Struct({ head: Schema.String, status: ThreadStatus });
export type ThreadHead = typeof ThreadHead.Type;

/**
 * How each snapshot field is known: `recorded` in the session's own files, `derived` from them
 * by a join or a command's output (a T3 thread's provider file, git's own words), `asserted` by
 * an agent's text, `conflicting` (the source records more than one value; the first is kept), or
 * `unavailable` (not recorded: never filled in from the current state).
 */
export const SNAPSHOT_STATUSES = [
  "recorded",
  "derived",
  "asserted",
  "conflicting",
  "unavailable",
] as const;
export type SnapshotStatus = (typeof SNAPSHOT_STATUSES)[number];

/** What a rerun or a reviewer needs to know about how a session started. */
export const SnapshotFields = Schema.Struct({
  /** The commit the session started on (Codex records it; Claude Code doesn't). */
  startCommit: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  clientVersion: Schema.optional(Schema.String),
  modelProvider: Schema.optional(Schema.String),
  /** The first turn's: a session can switch later (then `conflicting`). */
  model: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.String),
  approvalPolicy: Schema.optional(Schema.String),
  sandbox: Schema.optional(Schema.String),
  permissionMode: Schema.optional(Schema.String),
  /** SHA-256 of the instructions text the session ran with, never the text. */
  instructionsSha: Schema.optional(Schema.String),
  /** `clean` or `dirty`, as git showed the tree before the session's first edit. */
  treeShown: Schema.optional(Schema.String),
  /** Lockfile digest of an identified tree: unavailable from history so far. */
  lockfileDigest: Schema.optional(Schema.String),
});
export type SnapshotField = keyof typeof SnapshotFields.Type;
export const SNAPSHOT_FIELDS = Object.keys(SnapshotFields.fields) as Array<SnapshotField>;

/** The snapshot manifest: its fields, its version, and how each field is known. */
export const SessionSnapshot = Schema.Struct({
  ...SnapshotFields.fields,
  manifestVersion: Schema.optional(Schema.Number),
  provenance: Schema.optional(Schema.Record(Schema.String, Schema.Literals(SNAPSHOT_STATUSES))),
});
export type SessionSnapshot = typeof SessionSnapshot.Type;

export const SNAPSHOT_MANIFEST_VERSION = 1;

/**
 * A manifest of `fields` without the missing or empty ones, each present field `recorded` unless
 * `statuses` says otherwise, each missing one `unavailable`.
 */
export const snapshotOf = (
  fields: Partial<Record<SnapshotField, string | null | undefined>>,
  statuses: Partial<Record<SnapshotField, SnapshotStatus>> = {},
): SessionSnapshot => {
  const values = Object.fromEntries(
    Object.entries(fields).filter(([, v]) => !!v?.trim()),
  ) as Partial<Record<SnapshotField, string>>;
  return {
    ...values,
    manifestVersion: SNAPSHOT_MANIFEST_VERSION,
    provenance: Object.fromEntries(
      SNAPSHOT_FIELDS.map((f) => [
        f,
        values[f] === undefined ? "unavailable" : (statuses[f] ?? "recorded"),
      ]),
    ),
  };
};

/** The snapshot's values alone, without its manifest version and statuses. */
export const snapshotValues = (s: SessionSnapshot): Partial<Record<SnapshotField, string>> =>
  Object.fromEntries(SNAPSHOT_FIELDS.flatMap((f) => (s[f] === undefined ? [] : [[f, s[f]]])));

/** The snapshot with more fields, and how they are known (already-known fields win). */
export const extendSnapshot = (
  s: SessionSnapshot,
  fields: Partial<Record<SnapshotField, string | null | undefined>>,
  status: SnapshotStatus,
): SessionSnapshot => {
  const values = snapshotValues(s);
  const added = Object.fromEntries(
    Object.entries(fields).filter(
      ([f, v]) => !!v?.trim() && values[f as SnapshotField] === undefined,
    ),
  );
  return snapshotOf(
    { ...values, ...added },
    {
      ...(s.provenance as Partial<Record<SnapshotField, SnapshotStatus>>),
      ...Object.fromEntries(Object.keys(added).map((f) => [f, status])),
    },
  );
};

/**
 * Where a session's history was read from: the native file (a T3 thread has none: its rows
 * change as it runs) and the SHA-256 of the bytes read, so a citation can say which version of
 * the source it rests on. Kept apart from the redacted record's own hash, which is a different
 * text.
 */
export const SessionOrigin = Schema.Struct({
  reader: Schema.Literals(["t3", "codex-rollout", "codex-app-server", "claude-transcript"]),
  file: Schema.optional(Schema.String),
  sha256: Schema.optional(Schema.String),
});
export type SessionOrigin = typeof SessionOrigin.Type;

export const ThreadView = Schema.Struct({
  thread: Schema.Struct({
    ...ThreadSummary.fields,
    head: Schema.String,
  }),
  entries: Schema.Array(Entry),
  labels: Labels,
  snapshot: Schema.optional(SessionSnapshot),
  origin: Schema.optional(SessionOrigin),
});
export type ThreadView = typeof ThreadView.Type;

export const LabelItem = Schema.Struct({ id: Schema.String, text: Schema.String });
export type LabelItem = typeof LabelItem.Type;
