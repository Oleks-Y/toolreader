# toolreader in production

Agent history lives on a history backend a team runs (`toolreader backend serve`, Postgres), one
workspace per team. Developers' machines send it; anyone with access builds a PR's page from it.

## Who writes it

The `codex-history` plugin selects a local Codex chat and its direct message peers. `history sync` sends its normalized thread and filtered rollout. The workspace token authorizes each writer. The `TOOLREADER_SYNC_STRATEGY` setting chooses manual sync, sync after a successful commit, sync after a successful push, or sync when the main session ends. The old repo-wide push and Stop hooks are not part of this flow. See [the pilot guide](codex-team-pilot.md).

## Storage

- Each selected Codex session has a normalized, redacted thread for the UI and a filtered rollout copy for agent SQL. The normalized view clips long outputs; the filtered event copy keeps the recorded text after the path and secret filter.
- An explicit `--sha` links the selected root chat to that commit after sync. Direct peers do not inherit its link.
- Workspaces and tokens (only each token's SHA-256). Retention is the database's: delete rows, or drop a workspace.

## Who reads it

- `toolreader history site --pr N --out DIR`: one self-contained `index.html` for the PR, read-only, loading nothing. Where it goes decides who can read it: a private host, a CI artifact on a private repo. Public Pages publish the agents' redacted sessions to everyone.
- The backend's `/v1` API, for anything else: commits by SHA, threads by id.
