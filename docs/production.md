# toolreader in production

Agent history lives on a history backend a team runs (`toolreader backend serve`, Postgres), one
workspace per team. Developers' machines send it; anyone with access builds a PR's page from it.

## Who writes it

| Writer                                       | Where its sessions are                                       | How it sends                                                                       |
| -------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Developer with T3 Code, Codex or Claude Code | T3's SQLite DB, Codex rollout files, Claude Code transcripts | the `pre-push` hook (`toolreader history hook install`), or `history sync` by hand |

- A commit is linked to the turns whose edits added its lines, so it doesn't matter when or where it was committed: after a rebase, a squash, a stack split from one branch.
- `pre-push`, in the background, once origin has taken the push: it sees the pushed range, never slows the push, and sends nothing for a push origin refused.
- Linking runs on the developer's machine, where the sessions are; only redacted threads and links leave it, over https (plain http only to the same machine), with the workspace's token.
- CI agents (`codex exec` in a job) aren't covered yet: their sessions live in the job's `CODEX_HOME` and would need `history sync` there, with a token.

## Storage

- Each linked thread once, whole: its history redacted, each output clipped to 8 KB head and tail. Sent again only when it changed (the client compares content hashes first).
- Each commit's links: which threads, which turns, how many of its new lines they wrote. Replaced whenever the commit is linked again.
- Workspaces and tokens (only each token's SHA-256). Retention is the database's: delete rows, or drop a workspace.

## Who reads it

- `toolreader history site --pr N --out DIR`: one self-contained `index.html` for the PR, read-only, loading nothing. Where it goes decides who can read it: a private host, a CI artifact on a private repo. Public Pages publish the agents' redacted sessions to everyone.
- The backend's `/v1` API, for anything else: commits by SHA, threads by id.
