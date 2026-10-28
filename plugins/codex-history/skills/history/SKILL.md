---
name: codex-history
description: Link your own local Codex session after a commit, sync selected history when preparing or updating a PR, or sync when asked. Use for Codex desktop and CLI sessions.
---

Run the installed `toolreader` helper from the repository. The team's private archive keeps the full available rollout, including context, tool inputs, results and command output. Setup must be complete before uploading.

After you commit work, link your own session to each relevant commit:

```sh
toolreader pilot sync --sha HEAD
```

Use `--role tested`, `--role reviewed` or `--role deployed` when that describes your work. A role is your claim of relevance, not proof of success. For a split, squash or rebase, name each new relevant commit. Do not claim another session's work as your own.

When preparing or updating a PR, or when asked to sync history:

```sh
toolreader pilot sync
```

Sync before completing the PR preparation or update. Link any relevant commits that you have not linked yet, with `--sha COMMIT`. Do not add a PR relation or post history links to the PR.

`CODEX_THREAD_ID` identifies your session. If it is absent, use `--session YOUR_SESSION_UUID`, from this chat's known identity. Never select the most recent session as a substitute.

The helper adds direct message peers whose UUIDs appear in supported message events. Add each other chat you actually sent a message to or received a message from with `--related UUID`. Use the UUID from the message tool result or the received message context. This covers desktop messages and code-mode calls whose peer identity is not a structured event. Pass only direct peers. Do not list, search or read unrelated session contents to find candidates. Related chats supply context; the commit link belongs to your own session.

A missing peer artifact, partial JSON record, size limit, transport error, or bad upload receipt fails the command. Report that failure. Earlier session uploads can exist after a later failure. Do not report success, schedule retries, or start a recovery queue. Keep working on independent work.

Cloud sessions are outside this pilot. This plugin does not replace the team's review process.

The helper also sends local hook capture artifacts for the selected session IDs. These files retain their source (`rollout`, `hook`) in the backend. Query complete recorded data through `agent_history_events`; `agent_entries` remains a compatibility view and can shorten outputs. Do not claim an approval decision from a PermissionRequest hook alone. Live app-server traffic capture is not supported.
