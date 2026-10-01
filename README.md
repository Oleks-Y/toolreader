# toolreader

Read-only viewer for what coding agents _did_ in T3 Code threads (Codex, Claude, Cursor).
It reads T3's database `~/.t3/userdata/state.sqlite` read-only and never writes to T3.

```bash
vp i              # install (runs effect-tsgo patch + git hooks)
vp run start      # build + serve on http://127.0.0.1:4777
vp run dev        # API server (--watch) + Vite dev server; open the Vite URL
vp test run       # tests
vp check          # format + lint
vp run typecheck  # tsgo with the Effect language service
```

- `#/` lists every thread grouped by project. Running threads have a green dot.
- `#/t/<threadId>` shows the swimlane (drag to filter by time, click a dot to jump) over a turn → phase → action tree. Switches for kinds, notes, reasoning, failures only, folding and phases are saved in localStorage.
- "✨ Label with Codex" on a turn runs `codex exec` (read-only, ephemeral) with T3's text-generation model and caches labels in `~/.toolreader/labels.json`.

Env: `PORT` (4777), `T3_DB` (database path), `CODEX_BIN` (`codex`), `TOOLREADER_LABELS`.

Stack and conventions are copied from t3code: Vite+ (`vp`), Effect 4, `tsgo` + Effect language service, oxlint/oxfmt.
Agent instructions: [AGENTS.md](AGENTS.md). Design notes: [docs/spec.md](docs/spec.md).
