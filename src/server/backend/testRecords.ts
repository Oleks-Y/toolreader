// Tests only: records as a client sends them.
import type { Entry } from "../../core/domain.ts";
import type { CommitRecord, ThreadRecord } from "../../core/historyRecord.ts";

export const threadRecord = (id: string, entries: Entry[]): ThreadRecord => ({
  formatVersion: 1,
  thread: { id, title: "Add a", source: "codex", provider: "codex", origin: null, parent: null },
  takenAt: "2026-01-01T11:00:00.000Z",
  toolreaderVersion: "0.1.0",
  entries,
  labels: {},
  redactions: 0,
});

export const commitRecord = (sha: string, threadIds: string[]): CommitRecord => ({
  formatVersion: 1,
  repo: "acme/app",
  sha,
  subject: "feat: a",
  committedAt: "2026-01-01T12:00:00.000Z",
  novel: 4,
  explained: 3,
  links: threadIds.map((threadId) => ({ threadId, turns: ["u1"], via: "content", lines: 3 })),
  linkedAt: "2026-01-01T12:01:00.000Z",
  toolreaderVersion: "0.1.0",
});
