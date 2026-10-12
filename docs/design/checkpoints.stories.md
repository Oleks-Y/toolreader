# Checkpoints: user stories

Who uses checkpoints, and what each of them gets. Each story names the requirements it rests on (`checkpoints.requirements.md`), how it is checked, and its demo: one recorded run in the demo desktop, terminal first, then the same run's trace in a local Jaeger (`docs/observability/compose.yml`).

Actors:

- **Developer:** works with coding agents (Codex, Claude Code) in a repo, commits and pushes.
- **Reviewer:** reads a pull request and wants to know which agent sessions produced it.
- **Operator:** runs the backend for a team, and answers "did it upload, and why not?".

## S1. Opt in once, and every push keeps its agent history

As a developer, I opt a repo in once, so that every time I push, the agent sessions behind the pushed commits are stored, without git ever waiting for it.

- **Given** a repo whose commits a Codex session made, **when** I run `toolreader checkpoint hook install` and later `git push`, **then** the push returns at once, and in the background one record per (commit, session) reaches the backend.
- The hook's report goes to `~/.toolreader/checkpoint.log`, never to the terminal: what was stored, by which link, and which sessions were only possibly related.
- A repo that didn't opt in does nothing, and starts no Node process.
- Requirements: FR-C1, FR-C2, FR-C3, FR-C4, FR-C5, FR-C9, NFR-P1. Checked by `checkpointHooks.test.ts`, `scripts/smoke.sh`.

## S2. The backend is down, and nothing is lost

As a developer, when the backend can't be reached, my records wait on my machine and go out on the next run, so a bad moment never costs history.

- **Given** the backend is down, **when** a run collects records, **then** each is queued, already redacted, in `~/.toolreader/outbox/`, and the report says why.
- **When** the backend is back, **then** the next run sends what waited first, and empties the outbox.
- A record the backend will never take is reported once and dropped; it never blocks the rest.
- Requirements: FR-C12, NFR-P2. Checked by `BackendClient.test.ts`, `scripts/smoke.sh`.

## S3. An amend or rebase doesn't lose the history

As a developer, when I amend or rebase a commit, its history follows the new SHA.

- **Given** a stored commit, **when** I amend it, **then** `post-rewrite` sends git's old → new pair in the background, and nothing else.
- **When** anyone asks the backend for the new SHA, **then** they get the old commit's records, marked `matched: rewrite`.
- Requirements: FR-C5, FR-C7, FR-B5. Checked by `checkpointHooks.test.ts`, `Backend.test.ts`, `CheckpointStore.test.ts`.

## S4. Collect a range by hand, and see why each session is in or out

As a reviewer, I collect a range (or a PR) by hand and see, per commit, which sessions were stored and how they link, which were only possibly related, and which commits nothing links.

- **Given** a range, **when** I run `toolreader checkpoint collect --range A..B`, **then** each commit lists:
  - ✓ the records stored, with their link (`trailer`, `sha`, `time`, `session`, `evidence`);
  - ? sessions only weaker signals point at (reads, staging, scripts): not stored, for me to link with `ledger link`;
  - · commits no session links: nothing stored.
- Without a scope it refuses: it never sweeps every session on the machine.
- Requirements: FR-C1, FR-C8, FR-C9, FR-M1, FR-M2, FR-M6. Checked by `checkpointCli.test.ts`, `linking.test.ts`.

## S5. Secrets stay on my machine

As a developer, I trust that what leaves my machine is redacted: tokens become `[redacted]`, my home directory becomes `~`, and a record the backend would refuse is never sent.

- **Given** a session whose command printed a token, **when** it is stored, **then** the stored record holds `[redacted]` where the token was, and `~` for the home directory; the token appears nowhere in the database.
- The client runs the backend's own checks (`admitCheckpoint`) first: a record that isn't fully redacted is rejected before it is sent.
- Spans carry ids and counts, never session text, URLs or headers.
- Requirements: FR-R2, FR-R4, NFR-S1, NFR-S3. Checked by `checkpoint.test.ts`, `BackendClient.test.ts`, `Trace.test.ts`, `Backend.test.ts`.

## S6. One trace per run, client and backend together

As an operator, I see each run as one trace, from the command through the upload to the database, with the results counted, so I can tell what happened without reading anyone's sessions.

- **Given** `OTEL_TRACES_EXPORTER=otlp` and an endpoint (`docs/observability/compose.yml` runs Jaeger on 127.0.0.1), **when** a hook or a command uploads, **then** one trace holds the client's steps (`toolreader checkpoint collect` → `Checkpoints.take` → `BackendClient.put`) and the backend's (`http.server POST` → `Backend.put` → `CheckpointStore.put`), the backend as service `toolreader-backend`.
- `Backend.put` counts results (`result.inserted`, …) and rejection reasons (`rejected.not-redacted`, …).
- Requirements: NFR-O1, NFR-O2, NFR-O3, NFR-O4, NFR-S3. Checked by `Trace.test.ts`, `Backend.test.ts`.
