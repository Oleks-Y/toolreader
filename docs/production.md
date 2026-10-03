# toolreader in production

toolreader is a tool you add to a repo, not a service you run. The history lives in git on the
`agent-ledger` branch, and every reader is either the local server or a static page built from
that branch. Nothing has to stay up.

## Who writes the ledger

| Writer                                    | Where its sessions are                            | How it syncs                                                                                     |
| ----------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Developer with T3 Code                    | T3's SQLite DB, plus Codex via `codex app-server` | `toolreader ledger sync`, by hand or from the `pre-push` hook (`toolreader ledger hook install`) |
| Developer with Codex CLI                  | `$CODEX_HOME/sessions/**/rollout-*.jsonl`         | same; the rollout reader needs no T3 and no app-server                                           |
| CI agent (`codex exec` in GitHub Actions) | rollouts in the job's `CODEX_HOME`                | the `ledger` action, after the agent step, with `--push`                                         |

- Sessions are tied to a repo by their working directory: a worktree of the repo, or `$GITHUB_WORKSPACE` in CI.
- `pre-push` rather than `post-commit`: it runs once per push, sees the whole pushed range, and pushes `agent-ledger` along with the code.
- `--push` fetches `agent-ledger`, rebuilds the ledger commit on top of the remote tip and retries on a non-fast-forward. Entries are separate files, so concurrent CI jobs never conflict.
- CI needs `contents: write` to push the ledger branch.
- In CI the T3 database is absent and `codex app-server` is not needed; the job reads its own rollout files.
- Codex's `workspace-write` sandbox blocks writes to `.git`, so `git commit` fails inside `codex exec`. The usual shape is: the agent edits, a later workflow step commits. That commit has no `git commit` action in any session, so nothing ties it to one by default. Two ways to tie it:
  - `--session <id>` (repeatable) names the session: the most precise, when the job knows the id `codex exec` printed.
  - `--match-sessions` takes the one session that edited files in this workspace and ended between the previous commit and this one. If several did, the commit gets no entry and is reported as ambiguous. It looks only at the given `--codex-home`, so it is safe with a job-local `CODEX_HOME` (never point it at a shared one).
  - SHA and time matches always win over both.

```bash
export CODEX_HOME="$RUNNER_TEMP/codex"   # job-local: only this job's sessions
codex exec -s workspace-write "…"
git commit -am "…"                         # the step the sandbox wouldn't allow
toolreader ledger sync --source codex-rollouts --codex-home "$CODEX_HOME" \
  --range "$BASE..HEAD" --match-sessions --push
```

## Storage

- One JSON file per agent commit. Today that is 6–55 KB raw, and git's zlib and deltas store about a quarter of that.
- Outputs are clipped per action by default (head and tail, 8 KB total, marked as clipped); `--max-output 0` keeps them as the viewer has them (already at most 1500 + 1500 characters each), and `--no-outputs` drops them.
- Every free-text field is redacted before writing (`core/proof.ts`), commit subjects included, and again before publishing (`ledger site`, `ledger show`), which also drops the repo's local path. It is a faithful record, not tamper-proof evidence.
- Retention is git's: delete old `commits/*.json` on the ledger branch, or rebuild the branch.

## Who reads it

- **Local:** `toolreader serve` serves live T3 and Codex sessions, plus `#/ledger` for any repo on the machine.
- **Static:** `toolreader ledger site --range base..head --out dir` writes a self-contained page: the viewer with the range's entries inlined, in one `index.html` that loads nothing else. It opens from `file://`, a CI artifact, GitHub Pages or any static host. It reads the local `agent-ledger` branch; the action fetches origin's when the checkout has none.
- **PR review:** the action with `command: site` on `pull_request` builds that page for `base..head`, and writes `ledger show` to the job summary; the workflow uploads it as an artifact and links it ([`docs/ci/pr-ledger.yml`](ci/pr-ledger.yml)). With the repository variable `LEDGER_PAGES=true`, a second job publishes it to `pr/<number>/` on `gh-pages` and comments the link (same-repo PRs only: fork PRs get a read-only token).

Private repos: Pages sites are public except on GitHub Enterprise Cloud. Keep the artifact for private code.

## Packaging

- The npm package `toolreader` has one `toolreader` bin: `serve`, `ledger sync|show|site|hook`, `export`. The server is bundled with `vp pack`, as t3code does, because Node does not strip types under `node_modules`.
- The package is private: nothing is published. `npm pack` builds it (its `prepack` runs `vp run build`) and writes the tarball teams install from. All dependencies are bundled, so installing it pulls nothing else.
- A composite GitHub Action in `action/` installs the package (a tarball path, or a toolreader checkout it packs first; by default the checkout the action is in) and runs `ledger sync` or `ledger site`. Inputs: `command`, `repo`, `range`, `codex-home`, `max-output`, `push`, `out`, `args` (e.g. `--match-sessions`), `package`, `node-version`. On a runner with no git identity, the ledger commit is made as `github-actions[bot]`.
- [`docs/ci/agent-ledger.yml`](ci/agent-ledger.yml) is the CI writer above as a workflow: job-local `CODEX_HOME`, `codex exec`, a commit step, then `sync` with `--match-sessions` and `push: true`.

## Not built

- A hosted team service (ingest API, DB, auth). Build it once teams need history across many repos in one place.
- Claude Code and Cursor session readers.
