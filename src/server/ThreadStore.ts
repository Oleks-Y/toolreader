// The only module that knows T3's internal schema. If T3 migrates, fix it here.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ThreadNotFound } from "../core/api.ts";
import type {
  Labels,
  ThreadHead,
  ThreadStatus,
  ThreadSummary,
  ThreadView,
} from "../core/domain.ts";
import { normalize, type ActivityRow } from "../core/normalize.ts";
import { ToolPayload } from "../core/payload.ts";
import { ACTION_ITEM_TYPES, IMPORTED_ITEM_PREFIX, turnItemsToRows } from "../core/t3v2.ts";
import { ServerConfig } from "./ServerConfig.ts";

const ACTIVITY_KINDS = [
  "tool.started",
  "tool.updated",
  "tool.completed",
  "runtime.error",
  "tool.denied",
  "provider.turn.start.failed",
  "context-compaction",
];

const ThreadRow = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  projectId: Schema.String,
  projectTitle: Schema.String,
  provider: Schema.NullOr(Schema.String),
  status: Schema.NullOr(Schema.String),
  archivedAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  worktree: Schema.NullOr(Schema.String),
});
type ThreadRow = typeof ThreadRow.Type;
const HeadRow = Schema.Struct({ id: Schema.String, head: Schema.Number, last: Schema.String });
const CountRow = Schema.Struct({ n: Schema.Number });
const ActivityDbRow = Schema.Struct({
  id: Schema.String,
  at: Schema.String,
  kind: Schema.String,
  tone: Schema.String,
  summary: Schema.String,
  payload: Schema.String,
});
const MessageDbRow = Schema.Struct({
  id: Schema.String,
  at: Schema.String,
  role: Schema.String,
  text: Schema.String,
});
const ThreadHeadRow = Schema.Struct({
  exists: Schema.NullOr(Schema.Number),
  a: Schema.NullOr(Schema.Number),
  m: Schema.NullOr(Schema.String),
  s: Schema.NullOr(Schema.String),
  v: Schema.NullOr(Schema.String),
});
const V2CountRow = Schema.Struct({
  id: Schema.String,
  n: Schema.Number,
  last: Schema.NullOr(Schema.String),
});
const TurnItemDbRow = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  status: Schema.String,
  ordinal: Schema.Number,
  updatedAt: Schema.String,
  payload: Schema.String,
});

const decodeThreadRows = Schema.decodeUnknownEffect(Schema.Array(ThreadRow));
const decodeHeadRows = Schema.decodeUnknownEffect(Schema.Array(HeadRow));
const decodeCountRows = Schema.decodeUnknownEffect(Schema.Array(CountRow));
const decodeActivityRows = Schema.decodeUnknownEffect(Schema.Array(ActivityDbRow));
const decodeMessageRows = Schema.decodeUnknownEffect(Schema.Array(MessageDbRow));
const decodeThreadHeadRows = Schema.decodeUnknownEffect(Schema.Array(ThreadHeadRow));
const decodeV2CountRows = Schema.decodeUnknownEffect(Schema.Array(V2CountRow));
const decodeTurnItemRows = Schema.decodeUnknownEffect(Schema.Array(TurnItemDbRow));
/** Malformed payloads degrade to an untyped tool row instead of dropping the thread. */
const decodePayload = Schema.decodeUnknownOption(Schema.fromJsonString(ToolPayload));

export type T3Project = { readonly id: string; readonly title: string; readonly root: string };
const ProjectRow = Schema.Struct({ id: Schema.String, title: Schema.String, root: Schema.String });
const decodeProjectRows = Schema.decodeUnknownEffect(Schema.Array(ProjectRow));
const CursorRow = Schema.Struct({ threadId: Schema.NullOr(Schema.String) });
const decodeCursorRows = Schema.decodeUnknownEffect(Schema.Array(CursorRow));

/** V1 session statuses and V2 run statuses. */
const toStatus = (s: string | null): ThreadStatus =>
  s === "running" || s === "starting" || s === "preparing" || s === "queued" || s === "waiting"
    ? "running"
    : s === "error" || s === "failed"
      ? "error"
      : "idle";

function toSummary(r: ThreadRow, actionCount: number, lastActivity: string | null): ThreadSummary {
  return {
    id: r.id,
    source: "t3",
    origin: null,
    title: r.title,
    projectId: r.projectId,
    projectTitle: r.projectTitle,
    provider: r.provider,
    status: toStatus(r.status),
    archived: r.archivedAt !== null,
    updatedAt: lastActivity && lastActivity > r.updatedAt ? lastActivity : r.updatedAt,
    actionCount,
    worktree: r.worktree,
  };
}

export class ThreadStore extends Context.Service<
  ThreadStore,
  {
    readonly list: Effect.Effect<ReadonlyArray<ThreadSummary>>;
    readonly get: (id: string, labels: Labels) => Effect.Effect<ThreadView, ThreadNotFound>;
    readonly head: (id: string) => Effect.Effect<ThreadHead, ThreadNotFound>;
    /** Codex thread ids T3 runs itself (from its resume cursors), so other sources can skip them. */
    readonly codexThreadIds: Effect.Effect<ReadonlySet<string>>;
    readonly projects: Effect.Effect<ReadonlyArray<T3Project>>;
  }
>()("toolreader/server/ThreadStore") {
  /** No T3 database (e.g. CI): no threads, and no Codex sessions owned by T3. */
  static readonly empty = Layer.succeed(
    ThreadStore,
    ThreadStore.of({
      list: Effect.succeed([]),
      get: (id) => Effect.fail(new ThreadNotFound({ threadId: id })),
      head: (id) => Effect.fail(new ThreadNotFound({ threadId: id })),
      codexThreadIds: Effect.succeed(new Set()),
      projects: Effect.succeed([]),
    }),
  );

  static readonly layer = Layer.effect(
    ThreadStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { home } = yield* ServerConfig;

      // T3 0.0.46 nightlies moved to orchestration V2 (statev2.sqlite). Its database still has the
      // V1 tables, frozen at the upgrade: V1 threads keep their tool calls there, and V2 lists
      // every thread and holds what ran since. Older installs have the V1 tables alone.
      const [v2Table] = yield* sql`
        select count(*) n from sqlite_master where name = 'orchestration_v2_projection_turn_items'`.pipe(
        Effect.flatMap(decodeCountRows),
        Effect.orDie,
      );
      const v2 = (v2Table?.n ?? 0) > 0;

      const threadRows = (id: string | null) =>
        (v2
          ? sql`
          select t.thread_id id, t.title, t.project_id projectId, coalesce(p.title, '?') projectTitle,
                 t.default_provider provider,
                 (select r.status from orchestration_v2_projection_runs r
                  where r.thread_id = t.thread_id order by r.ordinal desc limit 1) status,
                 t.archived_at archivedAt, t.updated_at updatedAt,
                 coalesce(json_extract(t.payload_json, '$.worktreePath'), p.workspace_root) worktree
          from orchestration_v2_projection_threads t
          left join projection_projects p on p.project_id = t.project_id
          where t.deleted_at is null and (${id} is null or t.thread_id = ${id})`
          : sql`
          select t.thread_id id, t.title, t.project_id projectId, coalesce(p.title, '?') projectTitle,
                 s.provider_name provider, s.status, t.archived_at archivedAt, t.updated_at updatedAt,
                 coalesce(t.worktree_path, p.workspace_root) worktree
          from projection_threads t
          left join projection_projects p on p.project_id = t.project_id
          left join projection_thread_sessions s on s.thread_id = t.thread_id
          where t.deleted_at is null and (${id} is null or t.thread_id = ${id})`
        ).pipe(Effect.flatMap(decodeThreadRows));

      // Counting V1 actions reads every payload page, so counts are cached per thread and
      // recomputed only when that thread's newest activity row changes.
      const countCache = new Map<string, { head: number; n: number }>();

      const list = Effect.gen(function* () {
        const heads =
          yield* sql`select thread_id id, max(rowid) head, max(created_at) last from projection_thread_activities group by thread_id`.pipe(
            Effect.flatMap(decodeHeadRows),
          );
        const info = new Map<string, { n: number; last: string | null }>();
        for (const h of heads) {
          let cached = countCache.get(h.id);
          if (cached?.head !== h.head) {
            const [row] =
              yield* sql`select count(*) n from projection_thread_activities where thread_id = ${h.id} and kind = 'tool.completed'`.pipe(
                Effect.flatMap(decodeCountRows),
              );
            cached = { head: h.head, n: row?.n ?? 0 };
            countCache.set(h.id, cached);
          }
          info.set(h.id, { n: cached.n, last: h.last });
        }
        if (v2) {
          const counts = yield* sql`
            select thread_id id, count(case when type in ${sql.in(ACTION_ITEM_TYPES)} then 1 end) n,
                   max(updated_at) last
            from orchestration_v2_projection_turn_items
            where turn_item_id not like ${`${IMPORTED_ITEM_PREFIX}%`}
            group by thread_id`.pipe(Effect.flatMap(decodeV2CountRows));
          for (const c of counts) {
            const prev = info.get(c.id);
            const last = prev?.last && (!c.last || prev.last > c.last) ? prev.last : c.last;
            info.set(c.id, { n: (prev?.n ?? 0) + c.n, last });
          }
        }
        const rows = yield* threadRows(null);
        return rows
          .map((r) => toSummary(r, info.get(r.id)?.n ?? 0, info.get(r.id)?.last ?? null))
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      }).pipe(Effect.orDie, Effect.withSpan("ThreadStore.list"));

      // V2 items are rewritten in place (streamed text, status), not always with a newer
      // `updated_at`, so the V2 part of the marker also sums payload sizes.
      const head = Effect.fn("ThreadStore.head")(function* (id: string) {
        const [r] = yield* (
          v2
            ? sql`
          select (select 1 from orchestration_v2_projection_threads where thread_id = ${id} and deleted_at is null) "exists",
                 (select max(rowid) from projection_thread_activities where thread_id = ${id}) a,
                 (select max(updated_at) from projection_thread_messages where thread_id = ${id}) m,
                 (select status from orchestration_v2_projection_runs where thread_id = ${id} order by ordinal desc limit 1) s,
                 (select max(updated_at) || '/' || count(*) || '/' || total(length(payload_json)) from orchestration_v2_projection_turn_items where thread_id = ${id}) v`
            : sql`
          select (select 1 from projection_threads where thread_id = ${id} and deleted_at is null) "exists",
                 (select max(rowid) from projection_thread_activities where thread_id = ${id}) a,
                 (select max(updated_at) from projection_thread_messages where thread_id = ${id}) m,
                 (select status from projection_thread_sessions where thread_id = ${id}) s,
                 null v`
        ).pipe(Effect.flatMap(decodeThreadHeadRows), Effect.orDie);
        if (!r?.exists) return yield* new ThreadNotFound({ threadId: id });
        return {
          head: `${r.a ?? 0}:${r.m ?? ""}:${r.s ?? ""}${r.v ? `:${r.v}` : ""}`,
          status: toStatus(r.s),
        };
      });

      const get = Effect.fn("ThreadStore.get")(function* (id: string, labels: Labels) {
        const [row] = yield* threadRows(id).pipe(Effect.orDie);
        if (!row) return yield* new ThreadNotFound({ threadId: id });
        // Marker before content: a write landing mid-read then shows up as a newer marker on the next poll.
        const { head: marker } = yield* head(id);
        const activityRows = yield* sql`
          select activity_id id, created_at at, kind, tone, summary, payload_json payload
          from projection_thread_activities
          where thread_id = ${id} and kind in ${sql.in(ACTIVITY_KINDS)}
          order by created_at, rowid`.pipe(Effect.flatMap(decodeActivityRows), Effect.orDie);
        const messages = yield* sql`
          select message_id id, created_at at, role, text from projection_thread_messages
          where thread_id = ${id} order by created_at, rowid`.pipe(
          Effect.flatMap(decodeMessageRows),
          Effect.orDie,
        );
        const itemRows = v2
          ? yield* sql`
          select turn_item_id id, type, status, ordinal, updated_at updatedAt, payload_json payload
          from orchestration_v2_projection_turn_items
          where thread_id = ${id} order by ordinal`.pipe(
              Effect.flatMap(decodeTurnItemRows),
              Effect.orDie,
            )
          : [];
        const items = turnItemsToRows(itemRows);
        const activities = [
          ...activityRows.map(
            (r): ActivityRow => ({
              ...r,
              payload: Option.getOrElse(decodePayload(r.payload), () => ({})),
            }),
          ),
          ...items.activities,
        ];
        const entries = normalize(activities, [...messages, ...items.messages], {
          root: row.worktree,
          home,
        });
        const actionCount = entries.filter((e) => e.type === "action").length;
        const lastAt = entries.at(-1)?.at ?? null;
        return {
          thread: {
            ...toSummary(row, actionCount, lastAt),
            head: marker,
          },
          entries,
          labels,
        };
      });

      // Codex thread ids T3 resumes: V1 resume cursors, and V2 provider threads' native ids.
      const codexThreadIds = (
        v2
          ? sql`
        select json_extract(resume_cursor_json, '$.threadId') threadId
        from provider_session_runtime where provider_name = 'codex'
        union
        select json_extract(payload_json, '$.nativeThreadRef.nativeId') threadId
        from orchestration_v2_projection_provider_threads where provider = 'codex'`
          : sql`
        select json_extract(resume_cursor_json, '$.threadId') threadId
        from provider_session_runtime where provider_name = 'codex'`
      ).pipe(
        Effect.flatMap(decodeCursorRows),
        Effect.map((rows) => new Set(rows.flatMap((r) => (r.threadId ? [r.threadId] : [])))),
        Effect.orDie,
      );

      const projects = sql`
        select project_id id, title, workspace_root root from projection_projects where deleted_at is null`.pipe(
        Effect.flatMap(decodeProjectRows),
        Effect.orDie,
      );

      yield* list; // warm the action-count cache
      return ThreadStore.of({ list, get, head, codexThreadIds, projects });
    }),
  );
}
