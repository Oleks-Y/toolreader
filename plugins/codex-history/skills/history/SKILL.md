---
name: codex-history
description: Link your own local Codex session after a commit, sync selected history when preparing or updating a PR, or sync when asked. Use for Codex desktop and CLI sessions.
---

Run the installed `toolreader` helper from the repository. It sends a normalized thread and a filtered copy of the recorded rollout. The filtered copy keeps event order and full recorded text, while redacting secrets and machine paths outside the selected directories. Exact unfiltered rollout retention is off by default. Setup must be complete before uploading. `TOOLREADER_SYNC_STRATEGY` selects `on-demand` (default), `on-commit`, `on-push`, or `full` (detached upload started at `SessionEnd`). All modes use `toolreader history sync`; manual sync is always available. For full mode, check `$CODEX_HOME/toolreader-events/SESSION/sync-status.json` for `succeeded` or `failed`; `scheduled` and `running` do not prove delivery.

After you commit work, link your own session to each relevant commit:

```sh
toolreader history sync --sha HEAD
```

By default, local paths inside this repository are kept. Paths outside it are redacted. If the work used another directory and its paths should remain visible, include that directory when linking:

```sh
toolreader history sync --sha HEAD --include-dir ../shared-fixtures
```

`--include-dir` is repeatable. Relative directories resolve from the repository root; the helper checks the resolved directory, including symlinks. Use it only for directories relevant to this session. The selected directories are recorded with the filtered copy. This option affects path filtering, not what session files are selected.

If you find a sensitive value in this chat that the built-in filter may miss, write a local JSON array of exact strings and pass `--redact-file /absolute/path/to/private-redactions.json` on each manual sync. Keep that file outside Git and readable only by you. The helper replaces those strings in both the filtered and normalized history before upload. Do not put the values in command arguments. Automatic hook sync does not read this file, so choose manual sync when you need these extra redactions. This is an extra filter; the built-in secret and path filters always run.

Use `--role tested`, `--role reviewed` or `--role deployed` when that describes your work. A role is your claim of relevance, not proof of success. For a split, squash or rebase, name each new relevant commit. Do not claim another session's work as your own.

When preparing or updating a PR, or when asked to sync history:

```sh
toolreader history sync
```

Sync before completing the PR preparation or update. Link any relevant commits that you have not linked yet, with `--sha COMMIT`. Do not add a PR relation or post history links to the PR.

`CODEX_THREAD_ID` identifies your session. If it is absent, use `--session YOUR_SESSION_UUID`, from this chat's known identity. Never select the most recent session as a substitute.

The helper adds direct message peers whose UUIDs appear in supported message events. Add each other chat you actually sent a message to or received a message from with `--related UUID`. Use the UUID from the message tool result or the received message context. This covers desktop messages and code-mode calls whose peer identity is not a structured event. Pass only direct peers. Do not list, search or read unrelated session contents to find candidates. Related chats supply context; the commit link belongs to your own session.

A missing peer artifact, partial JSON record, size limit, transport error, or bad upload receipt fails the command. Report that failure. Earlier session uploads can exist after a later failure. Do not report success, schedule retries, or start a recovery queue. Keep working on independent work.

Cloud sessions are outside this pilot. This plugin does not replace the team's review process.

The helper also sends local hook capture artifacts for the selected session IDs. These files retain their source (`rollout`, `hook`) in the backend. Query filtered event objects through `agent_history_events`; `agent_entries` is the normalized view and can shorten outputs. Extracted media is available through the history media tool. Do not claim an approval decision from a PermissionRequest hook alone. Live app-server traffic capture is not supported. Filtering path strings does not remove file contents already pasted into a prompt or command output, and it does not inspect images for personal data.

For SQL investigations, use the plugin's `query-codex-history` skill. It maps the normalized and filtered views, explains version selection, and gives paged queries.
