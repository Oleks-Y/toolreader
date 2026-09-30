# toolreader

Read-only viewer for what coding agents *did* in T3 Code threads (Codex, Claude, Cursor).
Reads T3's database `~/.t3/userdata/state.sqlite` read-only; never writes to T3.

```bash
pnpm i
pnpm start        # build + serve on http://127.0.0.1:4777
pnpm dev          # API server with --watch + Vite dev server (open the Vite URL)
pnpm test         # core parsing/tree tests
```

- `#/` lists every thread grouped by project. Running threads have a green dot.
- `#/t/<threadId>` shows the swimlane (drag to filter by time, click a dot to jump) over a
  turn → phase → action tree. Switches for kinds, notes, reasoning, failures-only, folding and phases are saved in localStorage.
- "✨ Label with Codex" on a turn runs `codex exec` (read-only, ephemeral) with T3's
  text-generation model and caches labels in `~/.toolreader/labels.json`.

Env: `PORT` (4777), `T3_DB` (database path), `CODEX_BIN` (`codex`), `TOOLREADER_LABELS`.

Design notes: [docs/spec.md](docs/spec.md). All T3 schema knowledge lives in `server/db.ts`.
