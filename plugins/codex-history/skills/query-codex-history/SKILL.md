---
name: query-codex-history
description: Query Toolreader's workspace history SQL views to investigate Codex sessions, normalized entries, filtered rollout events, commit links, and media. Use when an agent needs recorded history evidence; this skill does not sync or publish history.
---

# Query the history layout

Use the read-only MCP `sql` tool or `toolreader history sql 'SELECT ...'`. The CLI prints one JSON object per row on stdout and row count, truncation, and coverage on stderr. The views are scoped to the configured workspace. They include only imported copies, which can lag live sessions. State conclusions as “not found in the imported scope as of `taken_at` or `checked_at`” unless completeness is established.

## Two representations

| View                       | Row and key                                                      | Use                                                                                                                                                                                        |
| -------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent_threads`            | One normalized thread; `id`, `version`                           | Title, source, parent, snapshot, entry count, `taken_at`, `checked_at`, `source_state`. Codex IDs have the form `codex:UUID`.                                                              |
| `agent_entries`            | One normalized entry; `thread_id`, `seq`                         | Convenient messages and actions. Includes `entry_id`, `turn`, `type`, `kind`, `status`, `command`, `output`, `text`, `files`, `media`. Text and diffs can be clipped or reshaped.          |
| `agent_filtered_rollouts`  | One filtered artifact version; `session_id`, `source`, `version` | Select a consistent raw copy. `source_sha256` identifies the source snapshot; `version` hashes the filtered JSONL. Also has `bytes`, `event_count`, `included_directories`, `uploaded_at`. |
| `agent_history_events`     | One recorded event; `session_id`, `source`, `version`, `seq`     | Inspect the filtered event object in `data`, ordered by `seq`. Includes `timestamp`, `event_type`. Unknown event types remain here.                                                        |
| `agent_codex_events`       | Same filtered events with convenience columns                    | `raw`, `payload`, `call_id`, `tool_name`, `tool_arguments`, `tool_input`, `tool_output`. Use `raw` when a convenience column misses a field.                                               |
| `agent_codex_artifacts`    | One artifact per root selection and version                      | Adds `root_id` and selection metadata. The same artifact can appear under several roots. `file_path` is null in agent SQL.                                                                 |
| `agent_commit_links`       | One normalized thread link per commit                            | `repo`, `sha`, `thread_id`, `role`, `version`, `turns`, `entries`, `via`.                                                                                                                  |
| `agent_codex_commit_links` | One selected Codex session link per commit                       | `repo`, `sha`, `session_id`, `role`, `linked_at`.                                                                                                                                          |

Normalized `thread_id = 'codex:' || session_id` for the same Codex session. The normalized `agent_threads.version` and filtered rollout `version` hash different representations; do not equate them. A session can have several filtered sources (`rollout`, `hook`, `app-server`) and several versions. Pin `session_id`, `source`, and `version` before reading an event sequence. A hook `PermissionRequest` records the request, not the later decision.

## Query pattern

Find a session and its imported copies:

```sql
SELECT t.id, t.version AS normalized_version, t.taken_at, t.checked_at,
       r.source, r.version AS filtered_version, r.source_sha256,
       r.event_count, r.uploaded_at
FROM agent_threads t
LEFT JOIN agent_filtered_rollouts r
  ON t.id = 'codex:' || r.session_id
WHERE t.id = 'codex:SESSION_UUID'
ORDER BY r.source, r.uploaded_at DESC;
```

Read one pinned copy in recorded order:

```sql
SELECT seq, timestamp, event_type, data
FROM agent_history_events
WHERE session_id = 'SESSION_UUID'
  AND source = 'rollout'
  AND version = 'FILTERED_SHA256'
  AND seq BETWEEN 1 AND 100
ORDER BY seq;
```

For a commit, discover both the normalized links and selected raw sessions. Use a full commit SHA when available. Run each statement in a separate call:

```sql
SELECT repo, sha, thread_id, role, version
FROM agent_commit_links
WHERE repo = 'owner/repo' AND sha = 'FULL_COMMIT_SHA';
```

```sql
SELECT repo, sha, session_id, role
FROM agent_codex_commit_links
WHERE repo = 'owner/repo' AND sha = 'FULL_COMMIT_SHA';
```

To inspect one call and result, filter `agent_codex_events` by the pinned session/version and `call_id`, then order by `seq`; check `raw` for repeated updates and records without a call ID.

The endpoint caps a response at 1000 rows, 1 MB, and 10 seconds. Page by `seq` and select only needed fields. For a long text field, request successive substrings, for example:

```sql
SELECT substring(tool_output #>> '{}' FROM 1 FOR 100000) AS output_part
FROM agent_codex_events
WHERE session_id = 'SESSION_UUID'
  AND version = 'FILTERED_SHA256' AND seq = 42;
```

Change the start offset to read the rest. Check the MCP result's `truncated` flag or the CLI's stderr. Never treat a capped response as a complete session.

## Media and limits

`toolreader-media:SHA256` in an event is a bucket reference. Fetch it with the MCP `media` tool using that hash, or run `toolreader history media SHA256 -o FILE`. A missing, outside-scope, invalid, or over-limit marker means those bytes were not imported. Exact unfiltered legacy artifacts are not in agent SQL. The filtered copy keeps recorded event objects and long text, but redacts recognized secrets and paths outside the selected directories. It cannot recover data Codex never recorded, remove file contents already pasted into text, or inspect images for personal data.
