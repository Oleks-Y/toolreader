# toolreader

Read-only viewer for what coding agents _did_ in T3 Code threads. It reads T3's SQLite database and shows each thread as a swimlane plus a turn → phase → action tree. Design notes live in `docs/spec.md`.

Setup, libraries and conventions are copied from `~/proj/t3code`. When in doubt, do what t3code does.

## The ways to hurt yourself

1. **Writing to the live T3 install.** `~/.t3/userdata` is the developer's real T3 database, in use while you work. toolreader opens it read-only, and it must stay that way. Never open it read-write, never run migrations against it, never "clean it up". For experiments, snapshot it (see Test data) and point `T3_DB` at the copy.
2. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or kill a PID found by matching a name. Kill only a PID you captured at spawn, or the owner of your port from `lsof -nP -iTCP:<port> -sTCP:LISTEN` after confirming its cwd is this repo.
3. **Binding beyond localhost.** The server exposes every agent session on the machine. It binds `127.0.0.1`; keep it that way.

## Where code lives

- `src/core`: browser-safe code shared by server and web.
  - `domain.ts`: Schema domain models (Action, Message, ThreadView, …).
  - `api.ts`: the `HttpApi` contract. Server and client both derive from it; never put server code here.
  - `payload.ts`: Schemas for T3's raw activity payloads, for every provider.
  - `normalize.ts`, `shell.ts`, `tree.ts`: pure transforms, from raw rows to entries to tree.
  - `codex.ts`: turns Codex `thread/read` items into the same T3-shaped rows.
  - `t3v2.ts`: turns T3's orchestration V2 turn items into the same rows. T3 0.0.46 nightlies write `statev2.sqlite`; its V1 tables stay, frozen at the upgrade, and still hold V1 threads' tool calls (V2 imports only their messages, under `migration:v1:` ids, which are skipped).
  - `rollout.ts`: scans rollout files for item timestamps and for the tool calls `thread/read` drops (it rebuilds items only from `item_completed` events, which most rollouts keep for messages alone), as app-server items. `shellJoin` quotes argv exactly as Codex does (Rust `shlex`).
  - `sanitize.ts`: what a ledger entry may carry off the machine. Paths in home directories outside the repo, emails and local names become placeholders (`anonymize`) or take their field, message or action with them (`remove`). `privacy.ts` is the website's publication check; both use its path and email patterns.
  - `rolloutThread.ts`: rebuilds the `thread/read` result from a rollout file alone (its `item_completed` events, mapped from the core's snake_case shapes to the app-server's camelCase), so sessions read without `codex app-server` give the same entries. `src/server/CodexRollouts.test.ts` pins this against a real `thread/read` capture (`src/server/fixtures/`).
- `src/server`: Effect services and the HTTP server.
  - `ThreadStore.ts` is the **only** module that knows T3's table layout. If T3 migrates, fix it there. It reads V1 tables alone (`state.sqlite`, older T3) or V1 and V2 together (`statev2.sqlite`), by whether the V2 tables exist.
  - `Labeler.ts` runs `codex exec` and caches labels in `~/.toolreader/labels.json`.
  - `CodexSessions.ts` lists and reads Codex sessions that ran outside T3, through a long-lived `codex app-server` process. Sessions T3 owns (its resume cursors) and subagent threads are skipped.
  - `CodexRollouts.ts` does the same straight from `$CODEX_HOME/{sessions,archived_sessions}/**/rollout-*.jsonl` (listing reads only each file's first line), for when there is no T3 and no app-server, e.g. CI after `codex exec`. Without a T3 database, `app.ts` provides `ThreadStore.empty` instead of failing.
  - `NodeSqliteClient.ts` is copied from t3code. Re-copy it rather than editing it.
  - `bin.ts` is the one `toolreader` CLI: `serve`, plus the `ledger` (`ledgerCli.ts`) and `export` (`export.ts`) commands. `vp pack` bundles it, with every dependency, to `dist/bin.mjs` (Node won't strip types under `node_modules`); the viewer builds to `dist/client` and the ledger site template to `dist/site`. `ServerConfig.distDir` finds `dist` from either the bundle or `src/server`. `app.ts` is the service wiring the commands share.
  - `Sanitizer.ts` gives `core/sanitize.ts` its rules (this machine's names, the repo's `.toolreader.json`) and runs the optional agent pass: `acp.ts` prompts an ACP agent (`codex-acp`, gpt-6-luna) over stdio through the Codex app-server protocol client, adding the `"jsonrpc"` field ACP needs and refusing every permission request. Refusing isn't containment (reads ask no permission): the agent also runs with Codex's tools off (`NO_TOOLS`) and a temp `CODEX_HOME` holding only `auth.json`. Refusing isn't containment (reads ask no permission): the agent also runs with Codex's tools off (`NO_TOOLS`) and a temp `CODEX_HOME` holding only `auth.json`. `Ledger.sync` sanitizes each entry it writes; `ledger sanitize` rewrites the whole branch as one commit. Tests use a fake ACP agent (`Sanitizer.test.ts`) and `Sanitizer.off`; never call the real one from tests.
  - `Proofs.ts` builds proof-of-work artifacts (`core/proof.ts`: schema, scope selection, redaction).
  - `Ledger.ts` syncs per-commit history onto the `agent-ledger` branch with git plumbing only (temp index, `commit-tree`, `update-ref` with the old value; never touches HEAD or the working tree) and reads ranges back. Matching and segmenting are pure, in `core/ledger.ts`. `ledgerCli.ts` is the CLI. Sessions are tied to a repo by `ThreadSummary.worktree` and come from `--source` (`auto` = T3 if its database exists, plus rollout files; `codex app-server` starts only for `--source codex-app-server`). `--push` builds on origin's `agent-ledger`, pushes with `--no-verify`, and moves the local branch only after the push lands; a push that loses a race refetches and rebuilds (5 attempts). `hook install` writes a `pre-push` hook and replaces or removes only a byte-identical one. Commits no `git commit` action made get a session only with `--session` or `--match-sessions` (one editing session in this worktree, else "ambiguous"). Sync refuses while a worktree has `agent-ledger` checked out. Entries are built by `core/ledger.ts` `buildEntry`, which redacts every free-text field, commit subject, title and labels included. Anything published (`site`, `show`, `sync`'s log) goes through `core/ledgerSite.ts` `publicRange`: free text redacted again, both commit objects included, the repo named by the remote's owner/name or its directory, and its path written as `.` wherever session text mentions it. `site` fills the template `dist/site/index.html` with that (`<` escaped in the inlined JSON).
- `src/codex-app-server`: t3code's Codex app-server client, copied. Its `README.md` lists the two local edits to re-apply when re-copying.
- `src/web`: React UI. Calls the server only through the typed client in `client.ts`.
  - `code.tsx`: syntax highlighting for expanded bodies, as t3code does it: Shiki through `@pierre/diffs`' shared highlighter, `FileDiff` for file diffs, `react-markdown` for notes, where images render as links (session text is untrusted, and an image loads by itself). `codeLang.ts` picks the language (pure, tested).
  - `FileDiff` virtualizes against the window scroll: never put it inside a scroll box, or it renders blank.
  - `LedgerPage.tsx` (`#/ledger`) renders each commit's entry through `ActionView` with `view` + `embedded` (read-only: no labeling or export). With `inline` it is the static page: `site.tsx` reads the inlined range and never calls the server.
  - `vite.site.config.ts` builds `site.tsx` into one HTML file with a classic inline script: Chrome blocks module scripts and chunk loads from `file://`. Its CSP lets only that script run (by hash) and nothing load (`img-src data:` only). Never add anything the page fetches (fonts, chunks, workers); `src/server/siteTemplate.test.ts` checks the template and its CSP, and `src/web/site.test.tsx` that session text can't add an image.
- `action/`: the composite GitHub Action. `run.sh` holds the logic and reads `INPUT_*` variables, so run it locally against a temp repo to test it (never against a real one). `docs/ci/` has example workflows; lint both with `actionlint`.
- `oxlint-plugin`: custom lint rules copied from t3code.
- `scripts/themes.py` generates `src/web/themes.css` (six themes, one hue per action kind) and fails if any two kinds get too close in color. Edit the script, never the CSS; re-run it with `python3 scripts/themes.py`.

## Taste

- Effect: read `~/proj/t3code/.repos/effect-smol/LLMS.md` before writing Effect code, and follow it. Use `Effect.fn("Name")`, services via `Context.Service` with a static `layer`, errors via `Schema.TaggedErrorClass`, and Schema (never hand parsing) for anything untrusted.
- Imports use namespace subpaths (`import * as Effect from "effect/Effect"`). Barrel imports are a type error.
- Hoist Schema decoders and encoders to module scope (`toolreader/no-inline-schema-compile`).
- Pure logic stays pure. `core/` functions take data and return data; Effect lives at the edges (server, client).
- Provider payloads vary wildly. Payload schemas keep every field optional and nullable, and a payload that fails to decode degrades to an untyped row instead of dropping the thread.
- Comments say how a thing is used, not what each line does.

## Test data

An empty database is a bad test. To run against realistic data without touching the live one:

```bash
rm -rf .t3 && mkdir .t3
node -e "new (require('node:sqlite').DatabaseSync)(process.env.HOME + '/.t3/userdata/statev2.sqlite', { readOnly: true }).exec(\"VACUUM INTO '.t3/statev2.sqlite'\")"
T3_DB=$PWD/.t3/statev2.sqlite PORT=4778 vp run start
```

`VACUUM INTO` is safe while T3 has the source open. A plain `cp` without the `-wal`/`-shm` files gives a corrupt copy.

## Verifying

- Run the smallest proof first: `vp test run <files>` for the tests you touched, then `vp check` (format and lint) and `vp run typecheck`. `vp run build` builds the viewer, the site template and the CLI bundle.
- Packaging changes: `npm pack`, install the tarball into a temp directory, and run `toolreader` from there.
- Changes to server behavior ship with focused tests. `ThreadStore` tests seed an in-memory SQLite database, and `Labeler` tests use a fake `codex` binary. Follow those patterns, and never call the real Codex from tests.
- Changes to normalization should also be run against the real data shape (a snapshot, as above), because providers emit payloads the unit tests don't cover.
- For UI changes, use the `test-toolreader` skill. Ask before opening browsers.

## Commits and PRs

- Conventional commit titles in plain language, e.g. `fix(viewer): failed searches no longer fold`.
- One concern per commit or PR. Pre-commit formats staged files (`vp staged`); CI runs check, typecheck, test and build.
