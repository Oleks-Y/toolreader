export const ACTION_KINDS = ["read", "search", "edit", "run", "git", "web", "tool", "agent"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export type FileChange = {
  path: string;
  added: number;
  removed: number;
  isNew: boolean;
  isDeleted: boolean;
  diff?: string;
};

export type Action = {
  type: "action";
  id: string;
  at: string;
  kind: ActionKind;
  status: "ok" | "failed" | "running";
  /** Humanized one-liner, e.g. "read src/x.ts:1-40 · search "foo" in src". */
  title: string;
  /** Agent-provided intent, e.g. Claude Bash `description`. */
  hint?: string;
  command?: string;
  exitCode?: number;
  output?: string;
  files?: FileChange[];
  /** Read/search targets, used to summarize folded groups. */
  targets?: string[];
  /** Search with no matches: not a failure. */
  noMatch?: boolean;
};

export type Message = {
  type: "message";
  id: string;
  at: string;
  role: "user" | "assistant" | "reasoning";
  text: string;
};

export type Event = {
  type: "event";
  id: string;
  at: string;
  tone: "error" | "info";
  text: string;
};

export type Entry = Action | Message | Event;

export type ThreadStatus = "running" | "idle" | "error";

export type ThreadSummary = {
  id: string;
  title: string;
  projectId: string;
  projectTitle: string;
  provider: string | null;
  status: ThreadStatus;
  archived: boolean;
  updatedAt: string;
  actionCount: number;
};

export type ThreadView = {
  thread: ThreadSummary & { worktree: string | null; head: string };
  entries: Entry[];
  labels: Record<string, string>;
};
