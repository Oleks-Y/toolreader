# toolreader

Read-only viewer for what coding agents _did_: T3 Code threads (Codex, Claude, Cursor) plus Codex sessions run outside T3 (CLI, TUI, Desktop, `codex exec`).
It reads T3's database `~/.t3/userdata/statev2.sqlite` (`state.sqlite` before T3 0.0.46) read-only, reads Codex history through `codex app-server` (or straight from rollout files), and never writes to either.

```bash
vp i              # install (runs effect-tsgo patch + git hooks)
vp run start      # build + `toolreader serve` on http://127.0.0.1:4777
vp run dev        # API server (--watch) + Vite dev server; open the Vite URL
vp test run       # tests
vp check          # format + lint
vp run typecheck  # tsgo with the Effect language service
vp run build      # dist/client (viewer), dist/site (history page template), dist/bin.mjs (CLI)
```

Everything runs through one `toolreader` bin: `serve`, `export`, `history sync|site|hook`, `backend serve|token`. In this repo, `node src/server/bin.ts <command>` (or `vp run history -- …`, `vp run export -- …`).

To use it in another repo, pack it (the package is private; nothing is published) and install the tarball. All dependencies are bundled, so it installs nothing else:

```bash
npm pack                                   # builds, writes toolreader-<version>.tgz
npm install --save-dev ./toolreader-0.1.0.tgz
npx toolreader --help
```

- `#/` lists every session grouped by project, with filters for t3, codex, scripted (`codex exec`, hidden by default) and archived. Running sessions have a green dot.
- `#/t/<threadId>` shows the swimlane (drag to filter by time, click a dot to jump) over a turn → phase → action tree. Switches for kinds, notes, reasoning, failures only, folding and phases are saved in localStorage.
- Command words are colored by what they do (setup, build, run, test, docker, git, read, …), with six themes in the picker (Tokyo Night, Catppuccin Mocha, Starship, Dracula, Gruvbox Dark, GitHub Light).
- "✨ Label with Codex" on a turn runs `codex exec` (read-only, ephemeral) with T3's text-generation model and caches labels in `~/.toolreader/labels.json`.

Proof of work: export a thread or some of its turns as JSON into the repo the agent changed, then open it later in toolreader (`#/file`).

```bash
toolreader export <threadId> [--turns 3-5] [--from ISO --to ISO] [--no-outputs] [--repo PATH] [--stdout]
# → <repo>/.agent-work/<branch>/<title>-<id>[-t3-5].json
```

Secrets (API keys, tokens, `Authorization` headers, private keys, `*_PASSWORD=`/`*_TOKEN=` values, URL credentials) are replaced with `[redacted]` before writing.

Agent history per commit: which agent turns wrote each commit, kept on a history backend your team runs, and shown per PR as one page.

```bash
toolreader backend serve [--port 4780]                          # the backend, on Postgres at TOOLREADER_DATABASE_URL
toolreader backend token create --workspace team --name laptop  # prints a token, once
toolreader history hook install [--repo .]                      # opt in: every push sends its history, in the background
toolreader history sync --range main..HEAD [--dry-run]          # or by hand (--pr N, --sha X)
toolreader history site --pr 42 [--out DIR]                     # the PR's page: DIR/index.html
```

`~/.toolreader/config.json` names the backend: `{"backend": {"url": "https://…", "token": "trk_…", "workspace": "team"}}`, or `TOOLREADER_BACKEND_URL`, `_TOKEN` and `_WORKSPACE`. Plain `http://` only to this machine: the token goes with every request.

A commit is linked to the agent turns whose edits added its lines, lines its parent didn't have, wherever and whenever those turns ran: in another worktree, days before the commit, before a rebase, a squash or a stack split from one branch, under a file name the commit has since moved. The page shows each link as its episode (the turns that wrote the lines and the short runs between them) and how many of the commit's new lines its agents wrote. An `Agent-Session: codex:<id>` trailer, which the `commit-msg` hook adds inside an agent session, names a thread outright. Each linked thread goes to the backend whole, once, redacted (secrets `[redacted]`, the home directory `~`), and again only when it grew; a commit's links are replaced whenever it is linked again.

The `pre-push` hook waits for git, asks origin whether it took the push (`git ls-remote`), and only then sends. It never stops or slows a push, reports to `~/.toolreader/history.log`, and a sync that failed (the backend down) is retried by the next push in that repo.

`history site` writes one self-contained `index.html`: read-only (no labeling or export), nothing loaded from the network (a CSP blocks it, and Markdown images in session text show as links), the repo by its remote's owner/name, never its local path. It opens from `file://` or any static host; where you put it decides who can read it.

Env: `PORT` (4777), `T3_DB` (database path; missing means no T3 threads), `CODEX_BIN` (`codex`), `CODEX_HOME` (`~/.codex`), `TOOLREADER_LABELS`.

Stack and conventions are copied from t3code: Vite+ (`vp`), Effect 4, `tsgo` + Effect language service, oxlint/oxfmt.
Agent instructions: [AGENTS.md](AGENTS.md). Design notes: [docs/spec.md](docs/spec.md).
