# toolreader: agent action viewer

Read-only viewer for what coding agents _did_ in T3 Code threads. Actions come first; words are optional.

## Scope

- Sources:
  - T3 Code's database `~/.t3/userdata/state.sqlite` (override with `T3_DB`), opened read-only. Covers every provider T3 runs (Codex, Claude, Cursor).
  - Codex sessions that ran outside T3 (CLI, TUI, Desktop, `codex exec`), read through `codex app-server`: `thread/list` for discovery, `thread/read` with `includeTurns` for content. Items carry no timestamps, so each item's time comes from the first rollout line that mentions its id. Sessions T3 runs itself are hidden (matched through T3's resume cursors); subagent threads are not listed. If `codex` can't start, this source is simply empty.
  - Claude Code sessions outside T3 are not read yet.
- Separate repo. Code borrowed from `~/proj/t3code` is copied with a source comment, never linked.
- Built with Effect: an `HttpApi` contract in `src/core/api.ts` shared by the server and a typed browser client. All T3 schema knowledge lives in `src/server/ThreadStore.ts`.
- Local only: the server binds `127.0.0.1`.

## Views

- **Sessions** (`#/`): all non-deleted threads grouped by project. Running threads are marked. Includes search by title.
- **Action viewer** (`#/t/<threadId>`):
  - **Swimlane** on top: one lane per action kind, failures in red. Idle gaps longer than 60s are compressed. Drag to filter the tree to a time range; click a dot to jump to its row.
  - **Tree** below: turn → phase → folded group → action. Every level collapses. Expanding an action shows its command, output and diffs.
  - **Switches** (saved in localStorage):
    - action kinds: read, search, edit, run, git, web, tool, agent
    - user prompts, agent notes, reasoning
    - failures only
    - fold reads
    - phase headers

## Rules

- Shell wrappers (`/bin/zsh -lc "…"`) are unwrapped. Chains (`&&`, `;`, `||`) are split and each part is humanized (`sed -n '1,260p' f` → `read f:1-260`). `cd` is dropped.
- Codex `commandActions` (read / search / listFiles) take priority over parsing. Claude Bash `description` is kept as a secondary label.
- Shell commands are classified by intent, never by toolchain: `setup` (installs/fetches), `build` (compile, typecheck, lint), `run` (dev servers, scripts, anything unrecognized), `test` (any test runner: `go test`, `vp test`, `cargo test`, `pytest`, …), plus `docker`, `git` (git/gh), `read`, `search`, `edit`, `web`, `tool` (MCP and other tools) and `agent`.
- Kind of a chain = strongest part: git > docker > test > build > run > edit > setup > web > agent > tool > search > read.
- Phases treat run/build/test/docker after an edit as verification.
- A failure is a non-zero exit, `is_error`, or status failed/declined. The exception is a search exiting 1, which means "no match".
- Phases per turn: explore until the first edit → edit → verify (the first run after edits) → fix (an edit after verify) → ship (a git/gh write after edits).
- Two or more consecutive successful read/search actions fold into one group.

## Codex labels (on demand)

- A "Label with Codex" button on each turn sends that turn's non-trivial actions and fold groups to `codex exec --output-schema`, run read-only and ephemeral.
- It uses the model and reasoning effort from T3's `textGenerationModelSelection` setting (default `gpt-5.6-luna`, `low`).
- Labels are cached in `~/.toolreader/labels.json` and never written to T3.

## Live updates

- While a thread is running, the viewer polls a cheap head endpoint (`/api/threads/:id/head`) every 3s. It re-fetches the full thread only when the head changes.
