# toolreader: agent action viewer

Read-only viewer for what coding agents _did_ in T3 Code threads. Actions come first; words are optional.

## Scope

- Sources:
  - T3 Code's database `~/.t3/userdata/state.sqlite` (override with `T3_DB`), opened read-only. Covers every provider T3 runs (Codex, Claude, Cursor).
  - Codex sessions that ran outside T3 (CLI, TUI, Desktop, `codex exec`), read through `codex app-server`: `thread/list` for discovery, `thread/read` with `includeTurns` for content. Items carry no timestamps, so each item's time comes from the first rollout line that mentions its id. Sessions T3 runs itself are hidden (matched through T3's resume cursors); subagent threads are not listed. If `codex` can't start, this source is simply empty.
  - The same Codex sessions straight from rollout files (`$CODEX_HOME/sessions/**/rollout-*.jsonl`), with no app-server: the `thread/read` result is rebuilt from the file's `item_completed` events, so entries are identical. Used by the ledger (e.g. in CI); the viewer still lists Codex sessions through the app-server.
  - Without a T3 database, the T3 source is empty instead of an error.
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

## Commit ledger

- Goal: see what the agent did for each commit, e.g. for a PR's `main..HEAD`.
- Entries live on a separate `agent-ledger` branch with its own history, never in the code history: `commits/<sha>.json` (`LedgerEntry`, `src/core/ledger.ts`) and `patch-ids.json` (patch-id → sha). Sync runs by hand (`vp run ledger -- sync`) or from a `pre-push` hook (`ledger hook install`); `--push` shares the branch.
- Sources (`--source`): `t3`, `codex-app-server`, `codex-rollouts`, or `auto` (T3 if its database exists, plus rollout files from `--codex-home`, default `$CODEX_HOME` or `~/.codex`). A missing source is an error only when asked for by name.
- Matching a commit to a session in the repo's worktrees: a SHA printed by `git commit` (`[branch abc1234] subject`) wins; otherwise the latest successful `git commit` action that started up to 10 minutes before the commit time. A commit no `git commit` action made (the agent edits, a later step commits: CI, where Codex's sandbox blocks `.git`) goes to the session in the worktree that ended last between the previous commit and this one, matched as "session", with that session's history since the previous commit. SHA and time matches win over it. Commits nobody matches are listed as "no agent history".
- An entry holds the history since that thread's previous commit action (or its start), up to the commit action. Leading discussion-only turns are dropped; a segment that starts mid-turn keeps the turn's prompt.
- After a rebase or amend that keeps the diff, `git patch-id --stable` finds the entry again (shown as "found by patch-id").
- Outputs and redaction work as for proof-of-work artifacts. Each output is then clipped to `--max-output` bytes (default 8192, head and tail, `0` keeps it): the action records the bytes cut (`clipped`) and the viewer says so. The viewer's outputs are already 1500 + 1500 characters at most, so the default rarely cuts.
- `--push` fetches `agent-ledger` from origin, writes the new commit on top of the remote tip (merging in local-only entries), pushes, and moves the local branch only once the push lands. A push that loses a race refetches and rebuilds, up to 5 attempts. Never touches HEAD or the working tree.
- The `pre-push` hook syncs each branch pushed to origin (`remote..local`, or `local --not --remotes=origin` for a new branch) with `--push`, skips pushes of `agent-ledger` itself, and warns instead of blocking the push if the sync fails. `hook install` is idempotent and never overwrites a hook it didn't write; it prints the lines to add instead.

## Codex labels (on demand)

- A "Label with Codex" button on each turn sends that turn's non-trivial actions and fold groups to `codex exec --output-schema`, run read-only and ephemeral.
- It uses the model and reasoning effort from T3's `textGenerationModelSelection` setting (default `gpt-5.6-luna`, `low`).
- Labels are cached in `~/.toolreader/labels.json` and never written to T3.

## Live updates

- While a thread is running, the viewer polls a cheap head endpoint (`/api/threads/:id/head`) every 3s. It re-fetches the full thread only when the head changes.
