# toolreader

Read-only viewer for what coding agents _did_: T3 Code threads (Codex, Claude, Cursor) plus Codex sessions run outside T3 (CLI, TUI, Desktop, `codex exec`).
It reads T3's database `~/.t3/userdata/state.sqlite` read-only, reads Codex history through `codex app-server`, and never writes to either.

```bash
vp i              # install (runs effect-tsgo patch + git hooks)
vp run start      # build + serve on http://127.0.0.1:4777
vp run dev        # API server (--watch) + Vite dev server; open the Vite URL
vp test run       # tests
vp check          # format + lint
vp run typecheck  # tsgo with the Effect language service
```

- `#/` lists every session grouped by project, with filters for t3, codex, scripted (`codex exec`, hidden by default) and archived. Running sessions have a green dot.
- `#/t/<threadId>` shows the swimlane (drag to filter by time, click a dot to jump) over a turn → phase → action tree. Switches for kinds, notes, reasoning, failures only, folding and phases are saved in localStorage.
- Command words are colored by what they do (setup, build, run, test, docker, git, read, …), with six themes in the picker (Tokyo Night, Catppuccin Mocha, Starship, Dracula, Gruvbox Dark, GitHub Light).
- "✨ Label with Codex" on a turn runs `codex exec` (read-only, ephemeral) with T3's text-generation model and caches labels in `~/.toolreader/labels.json`.

Proof of work: export a thread or some of its turns as JSON into the repo the agent changed, then open it later in toolreader (`#/file`).

```bash
vp run export -- <threadId> [--turns 3-5] [--from ISO --to ISO] [--no-outputs] [--repo PATH] [--stdout]
# → <repo>/.agent-work/<branch>/<title>-<id>[-t3-5].json
```

Secrets (API keys, tokens, `Authorization` headers, private keys, `*_PASSWORD=`/`*_TOKEN=` values, URL credentials) are replaced with `[redacted]` before writing.

Env: `PORT` (4777), `T3_DB` (database path), `CODEX_BIN` (`codex`), `TOOLREADER_LABELS`.

Stack and conventions are copied from t3code: Vite+ (`vp`), Effect 4, `tsgo` + Effect language service, oxlint/oxfmt.
Agent instructions: [AGENTS.md](AGENTS.md). Design notes: [docs/spec.md](docs/spec.md).
