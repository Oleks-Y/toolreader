# toolreader: agent action viewer

Read-only viewer for what coding agents _did_ in T3 Code threads. Actions come first; words are optional.

## Scope

- Sources:
  - T3 Code's database `~/.t3/userdata/statev2.sqlite` (`state.sqlite` before T3 0.0.46) (override with `T3_DB`), opened read-only. Covers every provider T3 runs (Codex, Claude, Cursor).
  - Codex sessions that ran outside T3 (CLI, TUI, Desktop, `codex exec`), read through `codex app-server`: `thread/list` for discovery, `thread/read` with `includeTurns` for content. Items carry no timestamps, so each item's time comes from the first rollout line that mentions its id. Sessions T3 runs itself are hidden (matched through T3's resume cursors); subagent threads are not listed. If `codex` can't start, this source is simply empty.
  - The same Codex sessions straight from rollout files (`$CODEX_HOME/sessions/**/rollout-*.jsonl`), with no app-server: the `thread/read` result is rebuilt from the file's `item_completed` events, so entries are identical. Used by `history sync` (e.g. in CI); the viewer still lists Codex sessions through the app-server.
  - Without a T3 database, the T3 source is empty instead of an error.
  - Claude Code sessions that ran outside T3 (CLI, desktop app, SDK hosts), from transcripts in `$CLAUDE_CONFIG_DIR/projects` (default `~/.claude`), as `claude:<sessionId>`. Sessions T3 runs and subagent files are skipped.
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

## Expanded bodies

- Highlighting runs only when a row is expanded, and each language loads on first use (Shiki, through `@pierre/diffs`). The Shiki theme follows the viewer theme.
- Commands are shown without their `/bin/zsh -lc` wrapper. Heredoc bodies get their own language from what consumes them (`python3 - <<PY`, `cat > x.ts <<EOF`).
- Outputs: JSON is pretty-printed, diffs and ANSI colors are detected, single-file reads use the file's language, anything else stays plain.
- File edits render as language-aware diffs (`FileDiff`). Diffs are stored as valid unified hunks; oversized ones are cut by whole hunks (or by lines with corrected header counts). Claude/Cursor edits hide line numbers, because they only know the edited snippet.
- Agent notes, reasoning and subagent prompts render as markdown; collapsed ones fade after two lines. Local file links show as code.

## Proof-of-work artifacts

- A thread, a turn range (`--turns 3-5`, as numbered in the viewer) or a time range exports as one JSON file: `ProofArtifact` (`src/core/proof.ts`) = `formatVersion`, export time, toolreader version, git branch/HEAD/remote of the repo, scope, outputs included/omitted, redaction count, and the `ThreadView` the viewer renders.
- The CLI writes it to `<repo>/.agent-work/<branch>/` (repo defaults to the thread's working directory); the viewer's export links download the same file. `#/file` opens one offline, read-only.
- Outputs are included by default (they double the size: a typical turn is ~19 KB, ~6 KB in git) and can be dropped with `--no-outputs`. Every free-text field is redacted, and the home directory becomes `~`. Redaction errs toward over-redacting.
- It is a faithful record, not tamper-proof evidence.

## Agent history

`toolreader history sync` selects one local Codex rollout by `CODEX_THREAD_ID` or `--session`, then only its direct message peers. It snapshots selected source files, extracts media, filters secrets and paths outside the chosen directories, uploads a filtered event copy, and sends the same snapshots through the normalized thread path. With `--sha`, it links the selected root session after both copies finish. See [the pilot design](codex-team-pilot.md).

`TOOLREADER_SYNC_STRATEGY` controls the plugin hooks: `on-demand` (default), `on-commit`, `on-push`, and `full` at `SessionEnd`. The hooks call the same selected uploader. The former range-based `HistorySync` and repo-wide git/project hooks remain in the codebase for older workflows; they are not the selected Codex sync path. Do not install them for the pilot.

## History backend

- `toolreader backend serve` (127.0.0.1, port 4780) on Postgres at `TOOLREADER_DATABASE_URL`, migrated on start; `backend token create --workspace SLUG --name NAME` prints a token once (only its SHA-256 is stored).
- `/v1` (`src/core/historyApi.ts`): `health`; `meta` (version, `minClient`, formats); per workspace, `threads/hashes`, `PUT threads`, `threads/query`, `PUT commits`, `repos/:repo/commits/query`. Every request but `health` needs the workspace's bearer token and a `toolreader-client` version header (below `minClient`: 426). Bodies over 64 MB: 413.
- Every record is checked again (`admitThread`/`admitCommit`): a format it knows, the schema, finite numbers, ids without NUL, and no text the redactor would still change. A refusal is a 422 that names fields and versions, never the record's text.
- The client (`src/server/history/HistoryClient.ts`) reads `backend.{url,token,workspace}` from `~/.toolreader/config.json` (or `TOOLREADER_BACKEND_*`); `http://` only to this machine.

## Packaging

- One `toolreader` bin (`src/server/bin.ts`): `serve`, `export`, `history sync|site|hook`, `backend serve|token`. `vp pack` bundles it with every dependency to `dist/bin.mjs`, as t3code does, because Node does not strip types under `node_modules`; the package ships only `dist/` and installs no dependencies. It stays private: install it from `npm pack`'s tarball.

## Codex labels (on demand)

- A "Label with Codex" button on each turn sends that turn's non-trivial actions and fold groups to `codex exec --output-schema`, run read-only and ephemeral.
- It uses the model and reasoning effort from T3's `textGenerationModelSelection` setting (default `gpt-5.6-luna`, `low`).
- Labels are cached in `~/.toolreader/labels.json` and never written to T3.

## Live updates

- While a thread is running, the viewer polls a cheap head endpoint (`/api/threads/:id/head`) every 3s. It re-fetches the full thread only when the head changes.
