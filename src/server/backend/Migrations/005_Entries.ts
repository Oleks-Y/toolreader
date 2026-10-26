// Search's index (decision D8, from the benchmark in docs/benchmark.md): one row per stored entry,
// with its searchable text (title, command, message text, output, file paths, joined by U+001F so a
// hit's snippet comes from the field that matched) under a trigram
// index, so a search reads only matching entries instead of unpacking every thread's history.
// Rows are rewritten whenever their thread is (`HistoryStore.putThread`) and go with it.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** The entries of the threads `where` selects, as `entries` rows (shared with the store). */
export const ENTRY_ROWS = `
  SELECT t.workspace_id, t.id, e->>'id', e->>'at', e->>'type',
         coalesce(e->>'kind', e->>'role'), e->>'status', e->>'title', t.payload->'thread'->>'title',
         concat_ws(chr(31), e->>'title', e->>'command', e->>'text', e->>'output',
           (SELECT string_agg(f->>'path', E'\\n')
            FROM jsonb_array_elements(coalesce(e->'files', '[]'::jsonb)) f))
  FROM threads t, jsonb_array_elements(t.payload->'entries') e`;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`;
  yield* sql`
    CREATE TABLE entries (
      workspace_id  uuid NOT NULL,
      thread_id     text NOT NULL,
      entry_id      text NOT NULL,
      at            text,
      type          text NOT NULL,
      kind          text,
      status        text,
      title         text,
      thread_title  text,
      search        text NOT NULL,
      PRIMARY KEY (workspace_id, thread_id, entry_id),
      FOREIGN KEY (workspace_id, thread_id) REFERENCES threads (workspace_id, id) ON DELETE CASCADE
    )`;
  yield* sql`CREATE INDEX entries_search ON entries USING gin (search gin_trgm_ops)`;
  yield* sql`CREATE INDEX entries_at ON entries (workspace_id, at DESC)`;
  yield* sql.unsafe(`
    INSERT INTO entries (workspace_id, thread_id, entry_id, at, type, kind, status, title,
                         thread_title, search)
    ${ENTRY_ROWS}
    ON CONFLICT DO NOTHING`);
});
