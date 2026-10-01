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
  - `codex.ts`: turns Codex `thread/read` items into the same T3-shaped rows, and scans rollout files for item timestamps.
- `src/server`: Effect services and the HTTP server.
  - `ThreadStore.ts` is the **only** module that knows T3's table layout. If T3 migrates, fix it there.
  - `Labeler.ts` runs `codex exec` and caches labels in `~/.toolreader/labels.json`.
  - `CodexSessions.ts` lists and reads Codex sessions that ran outside T3, through a long-lived `codex app-server` process. Sessions T3 owns (its resume cursors) and subagent threads are skipped.
  - `NodeSqliteClient.ts` is copied from t3code. Re-copy it rather than editing it.
- `src/codex-app-server`: t3code's Codex app-server client, copied. Its `README.md` lists the two local edits to re-apply when re-copying.
- `src/web`: React UI. Calls the server only through the typed client in `client.ts`.
  - `code.tsx`: syntax highlighting for expanded bodies, as t3code does it: Shiki through `@pierre/diffs`' shared highlighter, `FileDiff` for file diffs, `react-markdown` for notes. `codeLang.ts` picks the language (pure, tested).
  - `FileDiff` virtualizes against the window scroll: never put it inside a scroll box, or it renders blank.
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
node -e "new (require('node:sqlite').DatabaseSync)(process.env.HOME + '/.t3/userdata/state.sqlite', { readOnly: true }).exec(\"VACUUM INTO '.t3/state.sqlite'\")"
T3_DB=$PWD/.t3/state.sqlite PORT=4778 vp run start
```

`VACUUM INTO` is safe while T3 has the source open. A plain `cp` without the `-wal`/`-shm` files gives a corrupt copy.

## Verifying

- Run the smallest proof first: `vp test run <files>` for the tests you touched, then `vp check` (format and lint) and `vp run typecheck`.
- Changes to server behavior ship with focused tests. `ThreadStore` tests seed an in-memory SQLite database, and `Labeler` tests use a fake `codex` binary. Follow those patterns, and never call the real Codex from tests.
- Changes to normalization should also be run against the real data shape (a snapshot, as above), because providers emit payloads the unit tests don't cover.
- For UI changes, use the `test-toolreader` skill. Ask before opening browsers.

## Commits and PRs

- Conventional commit titles in plain language, e.g. `fix(viewer): failed searches no longer fold`.
- One concern per commit or PR. Pre-commit formats staged files (`vp staged`); CI runs check, typecheck, test and build.
