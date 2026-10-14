# Search benchmark (plan W4, input to decision D8)

The benchmark measures `history search` on the backend: today's scan of every stored entry
(`HistoryStore.search`: ILIKE over each thread's jsonb entries, newest first), against one index
candidate. Reproduce it with:

```bash
TOOLREADER_BENCH=1 TOOLREADER_BENCH_OUT=search-bench.md vp test run src/server/backend/searchBench.test.ts
```

## Setup

- **Data.** Synthetic sessions of 20 test actions each, with about 400 bytes of output per action.
  One session in 50 holds a rare string. A common word appears in about a tenth of all entries.
- **Database.** Postgres 17.5 in Docker, on a MacBook (Apple silicon).
- **Timing.** Single runs, end to end through the store, with a limit of 20 hits. Indicative, not
  statistical.
- **Last run:** 14 October 2026.

## Results

| corpus                          | rare text (ms) | common word (ms) | no match (ms) | trigram prefilter, rare (ms) | threads table (MB) |
| ------------------------------- | -------------- | ---------------- | ------------- | ---------------------------- | ------------------ |
| 1,000 sessions × 20 actions     | 56             | 86               | 51            | 65                           | 1                  |
| 10,000 sessions × 20 actions    | 618            | 902              | 521           | 64                           | 14                 |
| + one session of 20,000 actions | 609            | 16671            | 613           | 65                           | 14                 |
| same, with the trigram index    | 646            | 16725            | 596           | 3                            | 22                 |

## What it says

- **Pilot scale is fine as is.** At one or two teams' history, a few hundred to a few thousand
  sessions, today's scan answers in well under a second, and it grows linearly: about 0.6 s per
  10,000 sessions.
- **One long session is the real problem.** A single session of 20,000 actions makes a
  common-word search take about 17 s, close to 20 times the rest of the corpus put together.
  - The cost is unnesting and sorting that one huge jsonb array.
  - A trigram index on the whole payload doesn't change it. That index only helps pick which
    threads to open: a rare string drops from ~600 ms to 3 ms, while the table grows from 14 to
    22 MB.
- **What would fix it:** storing one row per entry (thread, entry, version, the searchable
  text), with a trigram or full-text index on those rows. Search would then read only matching
  entries, newest first, with no unnesting. That's a schema change, and it's what D8 decides.
  Long sessions are common with Codex rollouts (thousands of items).
- **Not measured here:** agentsview's SQLite index on the same archive, which is the baseline
  `docs/standards.md` names. Running that needs agentsview installed and the same archive given
  to both.

## Recommendation for D8

Keep the scan for the pilot's first weeks. Before any team with long sessions joins, move entries
into their own rows with a `pg_trgm` index, and add a full-text column only if queries turn out
to be words rather than fragments of errors and paths.
