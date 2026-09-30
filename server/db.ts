// The only file that knows T3's internal schema. If T3 migrates, fix it here.
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalize, type ActivityRow, type MessageRow } from "../core/normalize.ts";
import type { ThreadStatus, ThreadSummary, ThreadView } from "../core/types.ts";

export const DB_PATH = process.env.T3_DB ?? join(homedir(), ".t3", "userdata", "state.sqlite");
const db = new DatabaseSync(DB_PATH, { readOnly: true });

const ACTIVITY_KINDS = ["tool.started", "tool.updated", "tool.completed", "runtime.error", "tool.denied", "provider.turn.start.failed", "context-compaction"];
const kindList = ACTIVITY_KINDS.map((k) => `'${k}'`).join(",");

const toStatus = (s: unknown): ThreadStatus => (s === "running" || s === "starting" ? "running" : s === "error" ? "error" : "idle");

const THREAD_SQL = `
  select t.thread_id id, t.title, t.project_id projectId, coalesce(p.title, '?') projectTitle,
         s.provider_name provider, s.status, t.archived_at archivedAt, t.updated_at updatedAt,
         coalesce(t.worktree_path, p.workspace_root) worktree
  from projection_threads t
  left join projection_projects p on p.project_id = t.project_id
  left join projection_thread_sessions s on s.thread_id = t.thread_id
  where t.deleted_at is null`;

type ThreadRow = { id: string; title: string; projectId: string; projectTitle: string; provider: string | null; status: string | null; archivedAt: string | null; updatedAt: string; worktree: string | null };

function toSummary(r: ThreadRow, actionCount: number, lastActivity: string | null): ThreadSummary {
  return {
    id: r.id,
    title: r.title,
    projectId: r.projectId,
    projectTitle: r.projectTitle,
    provider: r.provider,
    status: toStatus(r.status),
    archived: r.archivedAt !== null,
    updatedAt: lastActivity && lastActivity > r.updatedAt ? lastActivity : r.updatedAt,
    actionCount,
  };
}

// Counting actions reads every payload page, so counts are cached per thread and
// recomputed only when that thread's newest activity row changes.
const countCache = new Map<string, { head: number; n: number }>();

export function listThreads(): ThreadSummary[] {
  const heads = db.prepare(`select thread_id id, max(rowid) head, max(created_at) last from projection_thread_activities group by thread_id`).all() as Array<{ id: string; head: number; last: string }>;
  const countStmt = db.prepare(`select count(*) n from projection_thread_activities where thread_id = ? and kind = 'tool.completed'`);
  const info = new Map<string, { n: number; last: string }>();
  for (const h of heads) {
    let cached = countCache.get(h.id);
    if (cached?.head !== h.head) {
      cached = { head: h.head, n: (countStmt.get(h.id) as { n: number }).n };
      countCache.set(h.id, cached);
    }
    info.set(h.id, { n: cached.n, last: h.last });
  }
  const rows = db.prepare(THREAD_SQL).all() as ThreadRow[];
  return rows.map((r) => toSummary(r, info.get(r.id)?.n ?? 0, info.get(r.id)?.last ?? null)).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** Cheap change marker for polling running threads. */
export function threadHead(id: string): { head: string; status: ThreadStatus } | null {
  const r = db
    .prepare(
      `select (select max(rowid) from projection_thread_activities where thread_id = $id) a,
              (select max(updated_at) from projection_thread_messages where thread_id = $id) m,
              (select status from projection_thread_sessions where thread_id = $id) s`,
    )
    .get({ id }) as { a: number | null; m: string | null; s: string | null } | undefined;
  if (!r) return null;
  return { head: `${r.a ?? 0}:${r.m ?? ""}:${r.s ?? ""}`, status: toStatus(r.s) };
}

export function getThread(id: string, labels: Record<string, string>): ThreadView | null {
  const row = db.prepare(`${THREAD_SQL} and t.thread_id = ?`).get(id) as ThreadRow | undefined;
  if (!row) return null;
  const activities = (
    db
      .prepare(`select activity_id id, created_at at, kind, tone, summary, payload_json payload from projection_thread_activities where thread_id = ? and kind in (${kindList}) order by created_at, rowid`)
      .all(id) as Array<Omit<ActivityRow, "payload"> & { payload: string }>
  ).map((r): ActivityRow => ({ ...r, payload: safeJson(r.payload) }));
  const messages = db.prepare(`select message_id id, created_at at, role, text from projection_thread_messages where thread_id = ? order by created_at, rowid`).all(id) as MessageRow[];
  const entries = normalize(activities, messages, { root: row.worktree, home: homedir() });
  const actionCount = entries.filter((e) => e.type === "action").length;
  return {
    thread: { ...toSummary(row, actionCount, activities.at(-1)?.at ?? null), worktree: row.worktree, head: threadHead(id)?.head ?? "" },
    entries,
    labels,
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
