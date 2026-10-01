# toolreader

Read-only viewer for what coding agents _did_: T3 Code threads (Codex, Claude, Cursor) plus Codex sessions run outside T3 (CLI, TUI, Desktop, `codex exec`).
It reads T3's database `~/.t3/userdata/state.sqlite` read-only, reads Codex history through `codex app-server` (or straight from rollout files, for the ledger), and never writes to either.

```bash
vp i              # install (runs effect-tsgo patch + git hooks)
vp run start      # build + `toolreader serve` on http://127.0.0.1:4777
vp run dev        # API server (--watch) + Vite dev server; open the Vite URL
vp test run       # tests
vp check          # format + lint
vp run typecheck  # tsgo with the Effect language service
vp run build      # dist/client (viewer), dist/site (ledger page template), dist/bin.mjs (CLI)
```

Everything runs through one `toolreader` bin: `serve`, `ledger sync|show|site|hook`, `export`. In this repo, `node src/server/bin.ts <command>` (or `vp run ledger -- …`, `vp run export -- …`).

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

Commit ledger: per-commit agent history, kept on a separate `agent-ledger` branch (`commits/<sha>.json` + `patch-ids.json`) so the code branch stays clean.

```bash
toolreader ledger sync [--repo .] [--range main..HEAD] [--no-outputs]   # add entries for agent commits in the range
git push origin agent-ledger                                            # share it
toolreader ledger show [--repo .] [--range main..HEAD]                  # list commits and their entries
toolreader ledger site [--repo .] [--range main..HEAD] [--out DIR]      # static page of the range (DIR/index.html)
toolreader ledger hook install [--repo .]                               # pre-push hook: sync what you push, --push
```

`sync` options: `--source auto|t3|codex-app-server|codex-rollouts` (`auto`: T3 if its database exists, plus Codex rollout files), `--codex-home DIR` (default `$CODEX_HOME` or `~/.codex`), `--max-output BYTES` (per output, head and tail; default 8192, `0` keeps it), `--push` (build on origin's `agent-ledger` and push, retrying if another push wins), `--session ID` / `--match-sessions` (for commits a later step made; see below).

Headless, e.g. in CI after `codex exec`, with no T3 and no app-server:

```bash
toolreader ledger sync --source codex-rollouts --codex-home "$CODEX_HOME" --range "$BASE..HEAD" --match-sessions --push
```

A commit a later step made (Codex's sandbox blocks `git commit`) has no session by default. `--session ID` names it; `--match-sessions` takes the one session that edited this worktree and ended before the commit, and reports the commit as ambiguous if several did. Use `--match-sessions` only with a `CODEX_HOME` holding just that job's sessions.

`#/ledger?repo=<path>&range=main..HEAD` shows each commit of the range with the actions that produced it. Entries are redacted like proof-of-work exports and found again by patch-id after a rebase or amend.

`ledger site` writes the same page as one self-contained `index.html` with the range's entries inlined: read-only (no labeling or export), theme picker kept, nothing loaded from the network. It opens from `file://`, a CI artifact, GitHub Pages or any static host. It reads the local `agent-ledger` branch, so fetch it first (`git fetch origin agent-ledger:agent-ledger`).

GitHub Actions: [`action/`](action/action.yml) is a composite action with `command: sync | site` (inputs `range`, `codex-home`, `max-output`, `push`, `out`, `args`, and `package`: a tarball or a toolreader checkout, by default the one the action is in). [`docs/ci/`](docs/ci/) has two example workflows: an agent job that runs `codex exec`, commits and syncs with `--push`, and a `pull_request` job that builds the page for base..head, uploads it as an artifact and links it in the job summary (publishing to Pages is opt-in; Pages sites are public except on GitHub Enterprise Cloud).

Env: `PORT` (4777), `T3_DB` (database path; missing means no T3 threads), `CODEX_BIN` (`codex`), `CODEX_HOME` (`~/.codex`), `TOOLREADER_LABELS`.

Stack and conventions are copied from t3code: Vite+ (`vp`), Effect 4, `tsgo` + Effect language service, oxlint/oxfmt.
Agent instructions: [AGENTS.md](AGENTS.md). Design notes: [docs/spec.md](docs/spec.md).
