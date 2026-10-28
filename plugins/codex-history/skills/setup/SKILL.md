---
name: codex-history-setup
description: Set up the team's private local Codex history pilot after plugin installation.
---

1. Check Node 24.13.1 or newer in the Node 24 line, and the team-approved `toolreader` build. Run `toolreader pilot sync --help`. Install only the team's reviewed tarball. Do not fetch an unverified package with `npx`.
2. Ask the team owner for the backend HTTPS URL, workspace slug and per-machine workspace token. Keep credentials outside the repository. Merge `backend.url`, `backend.workspace` and `backend.token` into `~/.toolreader/config.json`, preserving other settings. Restrict the file to the user. `TOOLREADER_CONFIG` selects another path; `TOOLREADER_BACKEND_URL`, `_WORKSPACE`, and `_TOKEN` override the file. Do not print the token.
3. Explain that the pilot uploads complete selected local Codex artifacts without publication redaction, including secrets already present in their context. The team must approve this private destination before first use. The backend must enable `TOOLREADER_CODEX_ARCHIVE_DIR` on a persistent private volume. Do not enable the old repo-wide push or Stop capture hooks for this pilot.
4. Have the user review and trust this plugin's current `SessionStart`, `PostToolUse`, and `PermissionRequest` hook definitions in Codex's hook controls. Installation does not grant trust. Never edit Codex's trust store. Restart or resume the chat after installing or changing hooks.
5. Run the history skill's helper for this setup chat only after the user has approved sending it to that destination. Confirm its byte count, event count and SHA-256 receipt. Report a failure as a failure. No retry or recovery is part of this pilot.

Use local Codex desktop or CLI sessions. Codex Cloud and personal review-triage configuration are outside this plugin.

The plugin records hook inputs locally under `$CODEX_HOME/toolreader-events/SESSION/hook/`. The PermissionRequest hook records the question only and returns no permission decision. Desktop approval answers are not available to that hook. The pilot reads native rollout files and supported hook inputs only. It does not intercept the client connection. Captured files upload only when their session is selected by `pilot sync`.
