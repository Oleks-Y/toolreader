import * as Schema from "effect/Schema";

export const ACTION_KINDS = [
  "read",
  "search",
  "edit",
  "run",
  "git",
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
  diff: Schema.optional(Schema.String),
});
export type FileChange = typeof FileChange.Type;

export const Action = Schema.Struct({
  type: Schema.Literal("action"),
  id: Schema.String,
  at: Schema.String,
  kind: ActionKind,
  status: Schema.Literals(["ok", "failed", "running"]),
  /** Humanized one-liner, e.g. `read src/x.ts:1-40 · search "foo" in src`. */
  title: Schema.String,
  /** Agent-provided intent, e.g. Claude Bash `description`. */
  hint: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Number),
  output: Schema.optional(Schema.String),
  files: Schema.optional(Schema.Array(FileChange)),
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

export const ThreadSource = Schema.Literals(["t3", "codex"]);
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
});
export type ThreadSummary = typeof ThreadSummary.Type;

export const Labels = Schema.Record(Schema.String, Schema.String);
export type Labels = typeof Labels.Type;

export const ThreadHead = Schema.Struct({ head: Schema.String, status: ThreadStatus });
export type ThreadHead = typeof ThreadHead.Type;

export const ThreadView = Schema.Struct({
  thread: Schema.Struct({
    ...ThreadSummary.fields,
    worktree: Schema.NullOr(Schema.String),
    head: Schema.String,
  }),
  entries: Schema.Array(Entry),
  labels: Labels,
});
export type ThreadView = typeof ThreadView.Type;

export const LabelItem = Schema.Struct({ id: Schema.String, text: Schema.String });
export type LabelItem = typeof LabelItem.Type;
