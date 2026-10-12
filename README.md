# toolreader

See what coding agents _did_: every file they read, command they ran and edit they made. toolreader also shows which agent turns wrote each commit.

**Website:** [toolreader-site.borith1111.workers.dev](https://toolreader-site.borith1111.workers.dev/), with a [live demo](https://toolreader-site.borith1111.workers.dev/demo/).

## Why

A diff shows what an agent changed. It doesn't show what the agent was asked, what it read, which tests failed along the way, or what it tried before the version you're reviewing. Chat transcripts have all of that, but buried in prose, one session at a time, and nothing ties them to commits.

toolreader puts the actions first:

- **The viewer** shows one session as a timeline of actions, grouped into phases: explore, edit, verify, fix, ship.
- **Agent history per commit** links each commit to the agent turns that wrote it, even after a rebase, squash or stack split. A reviewer gets one page per PR with the work behind every commit.

## What it reads

| Source                                    | Where                                                                                     | Session ids   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- | ------------- |
| T3 Code threads (Codex, Claude, Cursor)   | `~/.t3/userdata/statev2.sqlite` (`state.sqlite` before T3 0.0.46)                         | T3 thread id  |
| Claude Code (CLI, desktop app, SDK hosts) | `~/.claude/projects/**/*.jsonl` (`$CLAUDE_CONFIG_DIR`)                                    | `claude:<id>` |
| Codex (CLI, TUI, Desktop, `codex exec`)   | `codex app-server`, or straight from rollout files in `~/.codex/sessions` (`$CODEX_HOME`) | `codex:<id>`  |

Everything is opened read-only; toolreader never writes to any of them. Sessions that T3 runs are shown once, as T3 threads, and subagent sessions aren't listed separately. A missing source is just empty.

## How it works

1. **Normalize.** Each provider's records become the same kind of actions: read, search, edit, run, build, test, git, docker, web, tool, agent. Shell commands are unwrapped from `zsh -lc "…"`, split at `&&`/`;`/`||`, and classified by intent, not toolchain (`pytest`, `go test` and `vp test` are all _test_).
2. **View.** `toolreader serve` shows the sessions on `127.0.0.1` only. Each one is a swimlane (one lane per action kind, failures in red) over a turn → phase → action tree.
3. **Link commits.** `toolreader history sync` reads a range of commits and links each one to the agent turns whose edits added its lines. It matches by content, so time, worktree and file renames don't matter. An agent can also declare its own links (`history link`), which win over matching.
4. **Store and publish.** Linked threads go, redacted, to a history backend your team runs (Postgres). `history site` writes one self-contained HTML page for a PR.

## Install

The package is private, so pack it and install the tarball. Every dependency is bundled, so nothing else gets installed:

```bash
npm pack                                   # builds, writes toolreader-<version>.tgz
npm install -g ./toolreader-0.1.0.tgz      # or --save-dev in another repo
toolreader serve                           # http://127.0.0.1:4777
```

Commands: `serve`, `export`, `history`, `backend`. Run `toolreader <command> --help` for flags.

## The viewer

- **`#/`** lists every session, grouped by project. Filters: t3, codex, claude, scripted (`codex exec`, hidden by default) and archived. Running sessions have a green dot.
- **`#/t/<threadId>`** shows one session. Drag across the swimlane to filter by time; click a dot to jump to its row. Switches (kinds, notes, reasoning, failures only, folding, phases) are saved in localStorage.
- **Colors:** command words are colored by what they do (setup, build, run, test, docker, git, read, …). Six themes: Tokyo Night, Catppuccin Mocha, Starship, Dracula, Gruvbox Dark, GitHub Light.
- **✨ Label with Codex** on a turn runs `codex exec` (read-only, ephemeral) with T3's text-generation model. Labels are cached in `~/.toolreader/labels.json`.
- **`#/file`** opens a proof-of-work export.

## Proof of work

Export a session, or some of its turns, as JSON into the repo the agent changed. Open it later at `#/file`.

```bash
toolreader export <id> [--turns 3-5] [--from ISO --to ISO] [--no-outputs] [--repo PATH] [--stdout]
# → <repo>/.agent-work/<branch>/<title>-<id>[-t3-5].json
```

Secrets are replaced with `[redacted]` before writing: API keys, tokens, `Authorization` headers, private keys, `*_PASSWORD=` / `*_TOKEN=` values and URL credentials.

## Agent history per commit

### Set up

```bash
# Once per team: the backend, on Postgres at TOOLREADER_DATABASE_URL
toolreader backend serve [--port 4780]
toolreader backend token create --workspace team --name laptop   # prints a token, once

# Once per repo: what makes agents declare their commits (committed, so every agent gets it)
toolreader history skill install --commit

# Once per clone: opt in; every push to origin sends its history
toolreader history hook install
```

Point each machine at the backend in `~/.toolreader/config.json`:

```json
{ "backend": { "url": "https://…", "token": "trk_…", "workspace": "team" } }
```

Or set `TOOLREADER_BACKEND_URL`, `TOOLREADER_BACKEND_TOKEN` and `TOOLREADER_BACKEND_WORKSPACE`. Plain `http://` is allowed only to this machine, because the token goes with every request.

### Use

```bash
toolreader history sync --range main..HEAD [--dry-run]   # by hand; or --pr N, --sha X
toolreader history site --pr 42 [--out DIR]              # the PR's page: DIR/index.html
```

With the hooks installed, you rarely run `sync` yourself.

### How commits are linked

Three ways, strongest first:

1. **Declared.** Right after a commit, or after splitting, squashing or rebasing, the agent runs `history link --sha HEAD --turns 3-5 --note "…"` (`history turns` lists the numbers; `--session` names another session; `history unlink` takes a link back). The command stores nothing. It checks what it's told and prints the full SHA, and `sync` finds it later in the session. A declared link replaces what matching found for that thread.
2. **Trailer.** Inside an agent session, the `commit-msg` hook adds `Agent-Session: codex:<id>` or `claude-code:<id>`, which names the session outright.
3. **Matched by content.** Otherwise, a commit is linked to the turns whose edits added its new lines (lines its parent didn't have). That works wherever and whenever those turns ran: in another worktree, days earlier, before a rebase, squash or stack split, or under a file name that has since moved.

The PR page shows each link as an episode, meaning the turns that wrote the lines plus the short runs between them, along with how many of the commit's new lines its agents wrote.

### What `skill install` adds

- The skill: `.claude/skills/toolreader-history/SKILL.md`, linked from `.agents/skills/` for Codex.
- A short rule in `AGENTS.md` and `CLAUDE.md`. Every session reads these, while a skill is only read when the agent thinks of it.
- A hook that reminds the agent right after each `git commit` (`history remind`). It goes in `.claude/settings.json` for Claude Code and `.codex/hooks.json` for Codex, which runs it only after you approve it once with `/hooks`.

Existing content in those files stays. With `--commit`, a file that has other uncommitted changes is left for you to commit.

### What the git hooks do

- **`pre-push`** waits for git to finish, asks origin whether it took the push (`git ls-remote`), and only then sends. It never stops or slows a push. It reports to `~/.toolreader/history.log`, and a sync that failed (backend down) is retried by the next push.
- **`commit-msg`** adds the `Agent-Session` trailer. It never stops a commit.

An existing hook (Husky, Entire, …) is left alone, and `hook install` prints the snippet to run from it instead.

### What leaves the machine

Each linked thread is sent whole, once, and again only when it has grown. Before sending, secrets become `[redacted]` and the home directory becomes `~`. The backend checks every record again and refuses anything that fails.

`history site` writes one `index.html` that loads nothing from the network. A CSP blocks it, and Markdown images in session text show as links. The page is read-only (no labeling or export) and names the repo by its remote's owner/name, never its local path. It opens from `file://` or any static host; where you put it decides who can read it.

## Configuration

| Env                       | Default                                              | Meaning                                         |
| ------------------------- | ---------------------------------------------------- | ----------------------------------------------- |
| `PORT`                    | `4777`                                               | Viewer port (always on `127.0.0.1`).            |
| `T3_DB`                   | `~/.t3/userdata/statev2.sqlite`, else `state.sqlite` | T3 database. Missing file: no T3 sessions.      |
| `CLAUDE_CONFIG_DIR`       | `~/.claude`                                          | Claude Code home.                               |
| `CODEX_HOME`              | `~/.codex`                                           | Codex home.                                     |
| `CODEX_BIN`               | `codex`                                              | Codex binary, for the app-server and labeling.  |
| `TOOLREADER_LABELS`       | `~/.toolreader/labels.json`                          | Label cache.                                    |
| `TOOLREADER_CONFIG`       | `~/.toolreader/config.json`                          | Backend settings file.                          |
| `TOOLREADER_BACKEND_*`    |                                                      | `URL`, `TOKEN`, `WORKSPACE`; override the file. |
| `TOOLREADER_DATABASE_URL` |                                                      | Postgres, for `backend serve`.                  |

## Development

```bash
vp i              # install (runs the effect-tsgo patch and sets up git hooks)
vp run start      # build, then `toolreader serve` on http://127.0.0.1:4777
vp run dev        # API server (--watch) + Vite dev server; open the Vite URL
vp test run       # tests
vp check          # format + lint
vp run typecheck  # tsgo with the Effect language service
vp run build      # dist/client (viewer), dist/site (history page template), dist/bin.mjs (CLI)
```

In this repo, run commands with `node src/server/bin.ts <command>`, or `vp run history -- …` / `vp run export -- …`.

The stack and conventions are copied from t3code: Vite+ (`vp`), Effect 4, `tsgo` with the Effect language service, oxlint/oxfmt. Agent instructions: [AGENTS.md](AGENTS.md). Design notes: [docs/spec.md](docs/spec.md).
