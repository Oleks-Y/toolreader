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
 * How a session started, as its own files recorded it: what a rerun or a reviewer needs to know.
 * A field is absent when the source didn't record it; nothing is filled in from the current state.
 */
export const SessionSnapshot = Schema.Struct({
  /** The commit the session started on (Codex records it; Claude Code doesn't). */
  startCommit: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  clientVersion: Schema.optional(Schema.String),
  modelProvider: Schema.optional(Schema.String),
  /** The first turn's: a session can switch later. */
  model: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.String),
  approvalPolicy: Schema.optional(Schema.String),
  sandbox: Schema.optional(Schema.String),
  permissionMode: Schema.optional(Schema.String),
});
export type SessionSnapshot = typeof SessionSnapshot.Type;

/** `fields` without the ones that are missing or empty, as a snapshot. */
export const snapshotOf = (
  fields: Record<keyof SessionSnapshot, string | null | undefined>,
): SessionSnapshot =>
  Object.fromEntries(Object.entries(fields).filter(([, v]) => !!v?.trim())) as SessionSnapshot;

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
