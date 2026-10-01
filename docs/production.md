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

## Storage

- One JSON file per agent commit. Today that is 6–55 KB raw, and git's zlib and deltas store about a quarter of that.
- Outputs are clipped per action by default (head and tail, 8 KB total, marked as clipped); `--max-output 0` keeps them whole, and `--no-outputs` drops them.
- Every free-text field is redacted before writing (`core/proof.ts`). It is a faithful record, not tamper-proof evidence.
- Retention is git's: delete old `commits/*.json` on the ledger branch, or rebuild the branch.

## Who reads it

- **Local:** `toolreader serve` serves live T3 and Codex sessions, plus `#/ledger` for any repo on the machine.
- **Static:** `toolreader ledger site --range base..head --out dir` writes a self-contained page: the viewer with the range's entries inlined. It opens from `file://`, a CI artifact, GitHub Pages or any static host.
- **PR review:** the `ledger` action on `pull_request` builds that page for `base..head`, uploads it as an artifact and writes a job summary. With Pages enabled, it can publish to `pr/<number>/` and comment the link on the PR.

Private repos: Pages sites are public except on GitHub Enterprise Cloud. Keep the artifact for private code.

## Packaging

- The npm package `toolreader` has one `toolreader` bin: `serve`, `ledger sync|show|site|hook`, `export`. The server is bundled with `vp pack`, as t3code does, because Node does not strip types under `node_modules`.
- A composite GitHub Action in `action/` installs the package and runs `ledger sync` or `ledger site`.

## Not built

- A hosted team service (ingest API, DB, auth). Build it once teams need history across many repos in one place.
- Claude Code and Cursor session readers.
