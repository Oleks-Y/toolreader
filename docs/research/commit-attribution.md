# Commit attribution: which threads made a commit, and which changes nobody recorded

Research notes, 2026-10-02. The measurements are from this machine's real data. The prototypes are `provenance.py` (checkpoints only) and `provenance2.py` (actor + content), next to this file. Run them as `python3 docs/research/provenance2.py <repo> <range>` against a running `toolreader serve` on 4777.

## Answer first

- Today a commit maps to **at most one thread**, by a printed SHA or by commit time. That is right for "one agent, one commit". It is wrong when two agents contributed (one is dropped). It is misleading when you also edited by hand: the whole commit reads as the agent's.
- Two signals we don't use yet would make the mapping much better:
  1. **T3's per-turn worktree snapshots** (`refs/t3/checkpoints/<thread>/turn/<n>`), which are already in every repo T3 works in. They show _what content existed when_, including edits made by shell scripts and formatters.
  2. **Agent session ids in the environment**: Codex exports `CODEX_THREAD_ID`/`CODEX_SESSION_ID` to commands, and Claude Code exports `CLAUDE_CODE_SESSION_ID`. A git `commit-msg` hook can stamp them into the commit as trailers. That gives an exact, rebase-proof commit → session link.
- Integrity comes from **accounting, not guessing**. Each changed file, later each hunk, of a commit goes into exactly one bucket: _verified_, _attributed_, _shared_, _seen in worktree (actor unknown)_, or _untracked_. "Untracked" is shown with its diff, so missing history is visible instead of silently given to an agent.
- **Measured on the 48 commits of PRs #1–#10** (each changed file in each commit, 180 in total):

  | Bucket                | Count | Meaning                                                                     |
  | --------------------- | ----- | --------------------------------------------------------------------------- |
  | Verified              | 72    | One agent, and its turn left exactly this content                           |
  | Attributed            | 29    | One agent's recorded actions touched the file, but the content isn't proven |
  | Shared                | 29    | Several threads touched the file                                            |
  | Seen in worktree only | 50    | The change appeared during a turn, but no recorded action names the file    |
  | Untracked             | 0     | No record at all                                                            |

  The noise has known causes, listed below.

## 1. How the mapping works today

Code: `src/core/ledger.ts` (`findCommitActions`, `matchCommit`, `segmentFor`) and `src/server/Ledger.ts` (`sync`).

1. **Candidate sessions:** T3 threads and Codex sessions whose working directory is a worktree of the repo (`ThreadSummary.worktree`).
2. **Commit actions:** successful `git commit` actions, found by regex, in command position.
3. **Match.** In order:
   - the SHA printed by `git commit` (`[branch abc1234] subject`);
   - the latest commit action that started up to 10 minutes before the commit time;
   - only on request: `--session <id>`, or `--match-sessions` (the single editing session in this worktree, otherwise "ambiguous").
4. **Segment:** the thread's history after its previous commit action, up to this one, minus leading discussion-only turns.
5. **Write:** one entry per commit. The first match wins and existing entries are never replaced. Patch-id finds an entry again after a rebase or amend.

**Where it fails:**

| Case                                  | Today                                          | Problem                                          |
| ------------------------------------- | ---------------------------------------------- | ------------------------------------------------ |
| Two agents edit, one commits          | Only the committing thread                     | The other agent's work is invisible              |
| Agent edits, you tweak, agent commits | Whole commit = agent                           | Your edits are indistinguishable                 |
| Agent edits, you commit               | Nothing, unless `--session`/`--match-sessions` | Often no history                                 |
| Formatter / pre-commit hook rewrites  | Whole commit = agent                           | Not visible                                      |
| Rebase / squash                       | patch-id lookup of the old entry               | Breaks when the diff changes (conflicts, squash) |

## 2. Evidence that exists, and how good it is

### 2a. Agent action records ("who did what")

- **Edit tools carry a path and a diff.** Claude's Edit/Write and Codex's `apply_patch` record the path and the hunks (`Action.files[].diff`). The diffs are clipped for display (`normalize.ts`), so they are complete only for small edits.
- **Shell edits name no file reliably.** `python3 - <<EOF … open(p,"w")`, `sed -i`, `cp /tmp/x docs/y`, generators, formatters. The command text sometimes contains the path, but never the content.
  - Thread A (`5f9cc690`) changed about 20 files over 7 commits, yet only 7 of its 211 actions are edit actions with paths. The rest went through shell commands.
  - My own `docs/hosted.md` was written to `/tmp` and then copied in with `cp`, so no edit action names it.
- **Codex `thread/read` drops most tool calls.** Fixed in PR #3 by reading the rollout lines.
- **Claude Code `~/.claude/file-history`** keeps pre-edit backups only for its own Edit/Write tools, in only 2 sessions here. Codex keeps no snapshots: its rollouts have per-turn `turn_context` (cwd), and no `ghost_snapshot` items in the last 200 rollouts.

### 2b. T3 checkpoints ("what content existed when")

Traced in `~/proj/t3code`, `apps/server/src/vcs/GitVcsDriver.ts:662-741` and `orchestration/Layers/CheckpointReactor.ts`.

- **What a checkpoint is:** a parentless commit per turn boundary, `refs/t3/checkpoints/<base64url threadId>/turn/<n>`.
  - It is built from a temp index: `read-tree HEAD`, `add -A`, `write-tree`, `commit-tree`.
  - It includes untracked files and excludes ignored ones.
  - `turn/0` is the state before the first turn, and `turn/n` the state after turn n.
- **Not quite turn-end for Codex:** the snapshot is taken at the first diff update, mid-turn.
- **DB side:**
  - `projection_turns` links `thread_id`, `turn_id`, `checkpoint_turn_count`, `checkpoint_ref` and `checkpoint_files_json` (path, additions, deletions).
  - Full diffs are computed from the refs on demand.
- **Local only:** checkpoints are never pushed and never pruned, except that a revert deletes later turns.
- **Present in this repo:** 10 threads, from 58 checkpoints (this coordinator thread) down to 1–5 for the worker threads.
- **The catch: they snapshot the whole worktree.** When threads share a checkout, a turn's diff includes everyone's changes. Measured: thread A's turn 3 lists `README.md` and `docs/production.md`, which thread B was editing at the same time. Checkpoints prove **when** content appeared, not **who** wrote it.

### 2c. Session ids at commit time ("who committed")

- **Codex** (0.159) exports `CODEX_THREAD_ID`, `CODEX_SESSION_ID`, `CODEX_SANDBOX` and `CODEX_CI` to every command it runs.
- **Claude Code** exports `CLAUDE_CODE_SESSION_ID` (and `CLAUDECODE=1`, `AI_AGENT`).
- **T3 exports no thread id.** A provider session id maps back to the T3 thread through T3's resume cursors, which `ThreadStore` already reads for Codex.
- **Nested agents leak ids.** A `codex exec` started from Claude Code saw _both_ `CODEX_THREAD_ID` and `CLAUDE_CODE_SESSION_ID`. A hook must record all of them, as session and parent, not just one.
- **Trailers are the durable place for these ids:**
  - git keeps message trailers through rebase and amend;
  - GitHub keeps them in squash-merge bodies when the squash message lists the commits, which is a repository setting, so check it;
  - `git log --format='%(trailers:key=Agent-Session)'` reads them.

  The current `Co-Authored-By: Claude Opus 5.5` trailer names the model, not the session.

### 2d. Git itself

- **patch-id:** finds the "same change" after a rebase, but not after a conflict resolution or a squash.
- **Blob ids:** content-exact. A committed blob that equals a checkpoint blob proves that content existed in the worktree at that turn's boundary, wherever it came from. This survives rebases, because the content is the same.
- **The local reflog** records when commits were created, amended and rebased. It isn't pushed, but the collector can use it.

## 3. The experiment (PRs #1–#10, 48 commits, 180 changed files)

**Checkpoints only** (`provenance.py`):

- 71 file changes match a turn snapshot byte for byte.
- 109 are files that some turn changed, but the committed content matches no snapshot.
- 0 are files no turn ever changed.

So every committed change happened in a worktree while some recorded turn was open: nothing came from completely outside. But 109 of 180 can't be pinned to a snapshot. Likely causes, not yet measured individually:

- **Mid-turn commits:** the worker threads ran 2–5 long turns and made many commits inside each one. A file edited again after its commit no longer matches the turn-end snapshot.
- **Formatting on commit:** the pre-commit hook (`vp staged`) formats staged files, so the committed blob differs from what the agent left.

**Actor plus content** (`provenance2.py`):

- "Actor" = threads whose actions edited the path, either through the edit tool's `files`, or a shell write naming it, since the previous commit of that path.
- "Content" = a checkpoint blob of that same thread.
- Result: the table above.

What the noise teaches:

- **Shared (29):** mostly this coordinator thread plus one worker. I named files in commands (`git add docs/x`, `sed` on a doc) while workers edited them. Pure path mentions are weak evidence. Edits through a tool, or a shell write with the path as target, should count. Others, like `git add`, `cat` or `grep`, shouldn't.
- **Seen in worktree only (50):** files written by scripts or copied in, where no action names the path. Checkpoints catch these; action records can't.
- **One rule follows:** without per-agent worktrees, checkpoints can't separate concurrent agents. With them, a turn diff is exactly one agent's work plus anything a person did in that worktree.

## 4. Proposed model: account for every change

Per commit, the unit is first the file and later the hunk. Each change lands in exactly one bucket, with its evidence attached:

| Bucket               | Rule                                                                                   | Shown as                                                       |
| -------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Verified**         | One actor's recorded edits or own turn snapshot reproduce the committed content        | Agent X, exact                                                 |
| **Attributed**       | One actor's actions edited it, but the content isn't proven (shell edit, clipped diff) | Agent X, likely                                                |
| **Shared**           | Several actors edited it in the window                                                 | Agents X + Y                                                   |
| **Seen in worktree** | Content appeared at a turn boundary, but no actor's actions name it                    | Appeared during X's turn, actor unknown                        |
| **Untracked**        | No session, no snapshot                                                                | Not recorded (hand edit or outside any session), with the diff |

**Residual hunks** go one level deeper. For a file with an actor, diff the actor's last known content (snapshot or reconstructed edit) against the committed blob. Whatever is left (formatter output, a hand tweak, a later change) is shown as _untracked hunks_ inside an otherwise attributed file. This is the "integrity" view: the committed diff is the sum of what we can explain plus an explicit remainder.

**Linking a commit to threads:**

- Strongest: an `Agent-Session` trailer stamped by the hook.
- Then a printed SHA, then commit time.
- Plus every thread with actor evidence for its files, which is the multi-agent case.

A commit can link to many threads. Each link says how it was found and which files or hunks it covers.

**Rebases and squashes:** match blobs and hunks against the new commit's diff. Blob identity survives rebases that keep content, and trailers survive squash. patch-id stays a hint.

## 5. Signals worth adding, cheapest first

1. **A `commit-msg` hook that stamps trailers.**
   - It writes `Agent-Session: codex:<CODEX_THREAD_ID>`, `Agent-Session: claude-code:<CLAUDE_CODE_SESSION_ID>`, and `Agent-Parent-Session:` for outer agents.
   - When no agent variable is present, it writes nothing, so a commit with no trailer is a human (or unknown) commit.
   - It's about 20 lines, installed next to the pre-push hook. It is exact even when the agent commits quietly.
   - Caveat: a person committing from a terminal inside an agent's shell would be stamped as the agent.
2. **Reading T3 checkpoints in the collector:**
   - turn snapshots and `checkpoint_files_json` as worktree evidence;
   - blob matching against commits;
   - residual hunks.

   It needs no T3 changes. The data is already local.

3. **One worktree per agent** as the documented practice (T3's "New worktree"). It turns checkpoint diffs into per-agent evidence. Worth a warning in the viewer when two threads share a worktree in the same time window.
4. **A commit-time snapshot in the hook:** record `git write-tree` of the index and the worktree's blob ids in the ledger entry. Then a commit made outside T3 still has a "content at commit time" anchor, which helps with Codex/Claude Code sessions run outside T3.
5. **Codex outside T3:** `apply_patch` diffs are complete, but shell edits aren't. A collector could snapshot the worktree at Codex turn boundaries, which `turn_context` events mark. That needs the collector running during the session, as a later "watch" mode.

## 6. Edits outside any thread (later)

What can be known without more instrumentation:

- **Untracked hunks:** exactly what changed, but not who or why.
- **The local reflog and file mtimes:** roughly when.
- **The person's own note:** `toolreader note <sha> <file> "renamed by hand"`, recorded as an assertion, never as evidence.

What would need instrumentation:

- **Editor plugins** (VS Code/JetBrains local history): who, meaning the human in the editor, and when.
- **A file watcher in the collector:** when, and what content, but not which process wrote it. macOS FSEvents has no pid; Endpoint Security needs entitlements; Linux fanotify can give the pid.
- **Any other agent tool:** its own session reader.

Recommendation: ship the accounting view with explicit "untracked" first, add notes, and leave instrumentation until people ask "who made this untracked change" often enough to justify it.

## 7. Next experiments

1. **Demo repo with the hard cases**, each built from scratch with real agents:
   - Codex and Claude Code editing different files in one worktree, with one commit;
   - the same in two worktrees;
   - an agent edit plus a hand tweak plus the formatter;
   - an agent edit and a human commit.

   Run `provenance2.py` (made precise) on each, and check every bucket against what really happened.

2. **Measure the two suspected causes** of the 109 "touched, not exact" changes: re-format each checkpoint blob with `vp fmt`, and compare with the committed one; separately, check for mid-turn commits by comparing commit times with turn boundaries.
3. **Prototype the trailer hook:** commit from Codex, Claude Code, nested Codex-in-Claude, and a plain terminal, and check the trailers.
4. **If the buckets hold up:** ledger v2 (several links per commit, per-file buckets, residual hunks) and the viewer's coverage view, which is phase 1 of `docs/hosted.md`.
