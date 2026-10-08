# toolreader

Read-only viewer for what coding agents _did_: T3 Code threads (Codex, Claude, Cursor) plus Codex sessions run outside T3 (CLI, TUI, Desktop, `codex exec`).
It reads T3's database `~/.t3/userdata/statev2.sqlite` (`state.sqlite` before T3 0.0.46) read-only, reads Codex history through `codex app-server` (or straight from rollout files, for the ledger), and never writes to either.

```bash
vp i              # install (runs effect-tsgo patch + git hooks)
vp run start      # build + `toolreader serve` on http://127.0.0.1:4777
vp run dev        # API server (--watch) + Vite dev server; open the Vite URL
vp test run       # tests
vp check          # format + lint
vp run typecheck  # tsgo with the Effect language service
vp run build      # dist/client (viewer), dist/site (ledger page template), dist/bin.mjs (CLI)
```

Everything runs through one `toolreader` bin: `serve`, `ledger sync|show|explain|link|unlink|note|review|site|sanitize|hook`, `export`. In this repo, `node src/server/bin.ts <command>` (or `vp run ledger -- …`, `vp run export -- …`).

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
toolreader ledger hook install [--repo .] [--commit]                    # pre-push hook: sync what you push, --push
toolreader ledger sanitize [--repo .] [--agent on] [--push]             # rewrite agent-ledger as one sanitized commit
toolreader ledger explain [REV]                                         # one commit: its threads, files and notes
toolreader ledger link REV --session ID [--role coder|reviewer|committer]   # say which thread worked on a commit
toolreader ledger unlink REV --session ID
toolreader ledger note REV "fixed by hand" [--file PATH]
toolreader ledger review [REV]                                          # from an agent: link itself as reviewer
```

A commit can have several threads: coders, reviewers, a committer. Sync links each thread it finds and says how (`via`), strongest first: `asserted` (`link`/`review`), `trailer` (an `Agent-Session: codex:<id>` or `claude-code:<id>` line in the commit message), `sha` (its `git commit` printed the SHA), `session` (`--session`), `time` (its `git commit` ran just before), `evidence` (it edited the commit's files in this worktree since the previous commit). A later sync adds links and never removes one; `unlink` does. Each changed file is `attributed` (one thread edited it), `shared` (several) or `untracked` (none: a hand edit, say; add a `note`). A commit with no thread is recorded too, all its files untracked. A review counts for the SHA it reviewed; on any other commit (a rebase, a fix) it shows as stale.

`hook install --commit` also writes a `prepare-commit-msg` hook: a commit made inside an agent session (`CODEX_THREAD_ID` or `CLAUDE_CODE_SESSION_ID` set) gets an `Agent-Session` trailer, once. It is plain shell, does nothing outside an agent, and never stops a commit. Agents' session ids map to T3 threads through T3's provider threads; a Claude Code session outside T3 can't be linked.

`sync` options: `--source auto|t3|codex-app-server|codex-rollouts` (`auto`: T3 if its database exists, plus Codex rollout files), `--codex-home DIR` (default `$CODEX_HOME` or `~/.codex`), `--max-output BYTES` (per output, head and tail; default 8192, `0` keeps it), `--push` (build on origin's `agent-ledger` and push, retrying if another push wins), `--session ID` / `--match-sessions` (for commits a later step made; see below).

Headless, e.g. in CI after `codex exec`, with no T3 and no app-server:

```bash
toolreader ledger sync --source codex-rollouts --codex-home "$CODEX_HOME" --range "$BASE..HEAD" --match-sessions --push
```

A commit a later step made (Codex's sandbox blocks `git commit`) has no session by default. `--session ID` names it; `--match-sessions` takes the one session that edited this worktree and ended before the commit, and reports the commit as ambiguous if several did. Use `--match-sessions` only with a `CODEX_HOME` holding just that job's sessions.

### What leaves the machine

Session text is about the whole machine: an agent lists `~/proj`, reads other repos, names clients. `sync` therefore sanitizes every entry before it writes it, after redacting secrets:

- the repo's path reads `.`, and home `~`;
- paths in home directories outside the repo become `<path>`, emails `<email>` (except `noreply@…`, `@example.*`, `*.test`);
- this machine's names become `<private>`: user, hostname, git identity, the repo's sibling directories and skill names (ordinary English words are skipped), even inside compounds like `acme-api-db-1`.

`--sanitize anonymize` (default) keeps the structure with those placeholders; `--sanitize remove` drops what carries a hit: the output, file, message or the whole action when its command names something private. `--sanitize off` writes entries as they are.

`--sanitize-agent on` also has an ACP agent read the entries first (by default `codex-acp`, which must be installed, running `gpt-6-luna` with low effort, in an empty directory with its tools turned off and a Codex home holding only your login, so no config, MCP servers, skills or memories; every permission it asks for is refused). It names what else is private (other projects, clients, people, internal hosts); those spans are hidden everywhere like the rest. A reply that doesn't parse fails the sync rather than writing unchecked text, and the error never quotes it. The agent sees the text, so it goes to that model's provider.

`ledger sanitize` applies the same to every entry already on the branch (local and origin's) and writes them as one commit with no history, so no earlier version survives; `--push` replaces origin's copy unless it moved meanwhile. Rewriting entries never adds back what was hidden.

Settings come from `~/.toolreader/config.json` (this machine; `$TOOLREADER_CONFIG` moves it) and `.toolreader.json` at the repo root, in that order: lists add up, instructions too, and the repo's single values win; flags override both. Put private names in the machine's file, never in the repo's, which is published with the code.

```json
{
  "sanitize": {
    "mode": "anonymize",
    "allow": ["~/.codex", "t3code"],
    "private": ["acme"],
    "agent": {
      "enabled": false,
      "command": "codex-acp",
      "args": [],
      "model": "gpt-6-luna",
      "effort": "low",
      "instructions": "The client Acme and anything about its billing system are private."
    }
  }
}
```

`allow` lists path prefixes and names that may stay (the remote's owner and name always may); `private` adds names to hide; `instructions` is added to the agent's prompt. Whatever the agent names, text the project itself shows (its files at HEAD, branch names, commit messages) stays, and so do bare numbers, hex ids and loopback URLs. What the agent hid last is in `$(git rev-parse --git-path toolreader-sanitize.json)` for review; it is never printed, since CI logs are public. Any ACP agent works as `command`; `codex-acp` gets `CODEX_PATH` set to the `codex` on `PATH` (or `$CODEX_BIN`), since the Codex it bundles may not know the newer models.

`#/ledger?repo=<path>&range=main..HEAD` shows each commit of the range with the actions that produced it. Entries are redacted like proof-of-work exports and found again by patch-id after a rebase or amend.

`ledger site` writes the same page as one self-contained `index.html` with the range's entries inlined: read-only (no labeling or export), theme picker kept, nothing loaded from the network (a CSP blocks it, and Markdown images in session text show as links). Commit subjects are redacted like everything else, and the repo appears by its remote's owner/name (or directory name), never its local path; `ledger show` prints the same. It opens from `file://`, a CI artifact, GitHub Pages or any static host. It reads the local `agent-ledger` branch, so fetch it first (`git fetch origin agent-ledger:agent-ledger`).

GitHub Actions: [`action/`](action/action.yml) is a composite action with `command: sync | site` (inputs `range`, `codex-home`, `max-output`, `push`, `out`, `args`, and `package`: a tarball or a toolreader checkout, by default the one the action is in). [`docs/ci/`](docs/ci/) has two example workflows: an agent job that runs `codex exec`, commits and syncs with `--push`, and a `pull_request` job that builds the page for base..head, uploads it as an artifact and links it in the job summary (publishing to Pages is opt-in; Pages sites are public except on GitHub Enterprise Cloud).

Env: `PORT` (4777), `T3_DB` (database path; missing means no T3 threads), `CODEX_BIN` (`codex`), `CODEX_HOME` (`~/.codex`), `TOOLREADER_LABELS`.

Stack and conventions are copied from t3code: Vite+ (`vp`), Effect 4, `tsgo` + Effect language service, oxlint/oxfmt.
Agent instructions: [AGENTS.md](AGENTS.md). Design notes: [docs/spec.md](docs/spec.md).
