# toolreader as a hosted service: plan

Status: plan only. Nothing here is built yet. Revised after a design review (GPT-6.1-Sol); the review's points are folded in below.

toolreader becomes two parts:

- **Collector:** a local tool on each developer machine and CI runner. It finds agent sessions and proofs, links them to commits, and uploads only what the user approved.
- **Service:** a hosted place that keeps a team's agent histories and verification proofs, linked to repos, commits and PRs, and shows them in the viewer people already use.

Today's repo tool (the `agent-ledger` branch, `ledger site`, the GitHub Action) stays as the collector's offline mode and as an export.

What it shows: **recorded activity and verification evidence for a change**. It is a record, not tamper-proof evidence. Line-level authorship is an estimate at best, so it is never shown as fact.

## Use cases

- One commit made by one agent, by several agents, by an agent plus hand edits, or with no recorded agent at all.
- One session behind many commits, or behind none (research, review).
- Work done on another machine, or in a tool with no collector yet: it stays "unknown" until someone imports it or links it by hand.
- Proofs: a screenshot or recording of the feature working, a test report, a CI run, or a phone photo or video of a device. Each proof is tied to the revision it tested.

## Model: observations, matches, assertions

Three kinds of record, never mixed:

```
Observation  what a collector saw: a session segment, its file changes (paths, and the diff
             when complete), the repo/worktree/base commit, and proof capture details
Match        what the algorithm inferred: "segment S likely contributed to commit C", with
             evidence (printed SHA, time, explicit --session, files touched in both),
             algorithm version and completeness (complete | partial | unknown)
Assertion    what a person said: "I edited api.ts by hand", "S did not contribute", "this
             video verifies C". It has an author and a time, is audited, and never changes
             the evidence behind a match
```

- A commit has **many linked segments** (many-to-many), each with its evidence, plus an explicit **unknown** part: the files changed in the commit that no observed change explains.
- **Coverage is per file, not per line,** in the first release: "api.ts: Codex session (complete diff), test.ts: Claude Code (partial), README.md: unknown". Line-level estimates are a later experiment, and are always labeled as estimates.
- Matching uses the commit's parent and its actual tree, follows renames, and treats additions and deletions separately. Formatters and generators are recorded as transformations of their inputs, never as authors.
- **Time is a search hint, not a boundary.** Work can stay unstaged across commits, run in parallel, or be rebased later. The strong links are a printed SHA, an explicit `--session`, the same base commit, and files touched in both.
- Results are versioned: a collector can resubmit a match with a newer algorithm or more evidence, and the history is kept. Today's ledger keeps the first entry it wrote; v2 needs an explicit update policy.
- Rebase, amend and squash: patch-id only _suggests_ a relationship between revisions. The new commit's diff is matched again, and old PR heads are kept before a force-push.

## Proofs

- **A proof says what it proves.** Each one is either _reference_ (a design image, a screenshot the agent looked at) or _verification_ (it shows the change working).
- **Verification proofs record:**
  - the tested SHA, and whether the worktree was dirty;
  - the environment;
  - the command or manual procedure, and the result;
  - the capture time, and the CI run if any.

  The viewer marks a proof **stale** when the PR has moved past the SHA it tested.

- **Explicit first:** `toolreader proof add <file> --commit <sha> | --pr <n> --kind verification --note "…"`. Automatic pickup comes later, from T3 browser artifacts (read-only), agent images and CI artifacts. It must check that the file belongs to that session, and must refuse paths and symlinks outside the known artifact folders.
- **Storage:** content-addressed (sha256) in private object storage, behind authorization. A hash never grants access, and duplicates are found only within one tenant. Videos get a poster frame and are streamed.
- **Media is reviewed one item at a time** before upload, never approved per repo: screenshots and recordings can show customer data, notifications, audio and location.

## Privacy: what leaves the machine

Pattern redaction catches known secrets, not customer names, internal URLs, source code or query results. So:

- **The default upload is metadata only:** sessions (agent, model, times), commits, matches with their evidence, file paths, action kinds and counts, and statuses.
- **Content goes up only with explicit selection,** per field class: prompts, commands, diffs, outputs, labels, commit subjects, media. Redaction runs on everything selected, and the collector shows the exact outgoing bundle for review before the first upload, and whenever the policy changes.
- **Policies can be enforced per org** ("never upload outputs"). A policy is a hard limit on what collectors may send.

## Access, CI trust and retention

- **Access is checked per artifact, not just per repo.** Repo read access is necessary but not enough. A session that touched several repos, or that holds data from outside the repo, is visible only to the people the uploader chose (default: the uploader and the repo's maintainers). Permissions are checked on every read and download, with short-lived download links. Repo transfers, removed App installations and revoked users are handled explicitly.
- **CI uploads go through GitHub OIDC with a strict policy:**
  - the token's signature, issuer, audience, expiry and stable repository id are checked;
  - only approved workflow files, events and environments are accepted, and fork PRs get a separate, read-only policy;
  - the token is exchanged for a short-lived, repo-scoped, write-only upload token.

  Uploads are stored as claims and record the workflow run that sent them. Size and decompression limits, quotas, and safe rendering of all uploaded text apply.

- **Device tokens** come from `toolreader login`, are scoped to chosen repos, and can be revoked.
- **Retention and deletion are part of the MVP:**
  - retention is set per org;
  - deletion covers entries, media, poster frames, search indexes and cached downloads, and leaves tombstones so old collectors can't upload the data again;
  - there is an audit log of uploads, reads of content, assertions and deletions.

  Copies on the offline ledger branch and in static exports are separate, and the docs say so.

## Architecture

```
dev machine / CI runner                          service
┌───────────────────────────────┐   HTTPS     ┌───────────────────────────────────┐
│ collector (toolreader CLI)    │ ──────────▶ │ ingest API (Effect HttpApi)       │
│ - sources: T3 DB (ro), Codex  │  approved   │ - device tokens / OIDC exchange   │
│   rollouts; later Claude Code │  bundles    │ Postgres: tenants, repos, commits,│
│ - observations + matching     │             │   observations, matches, asserts, │
│ - upload policy + review      │             │   proofs, audit, tombstones       │
│ - offline: agent-ledger/site  │             │ private object storage: content   │
│ - local viewer (serve)        │             │ viewer (same React app) + auth    │
└───────────────────────────────┘             │ GitHub App: PR check + link       │
                                              └───────────────────────────────────┘
```

- **Matching runs in the collector, where the raw evidence is.** The service stores the results and can ask collectors to re-run them. It cannot recompute matches itself from redacted data.
- **Stack:** the existing Effect server, extended, with Postgres (`@effect/sql-pg`), S3-compatible private object storage, sign-in with GitHub, and the GitHub App. It ships as one container image, so it can be hosted or self-hosted.

## Phases (smallest valuable first)

1. **Several sessions per commit, locally.** Ledger v2:
   - each commit links several segments, each with its evidence and completeness, plus the files left unknown;
   - there is an update policy, so a re-sync can replace a match instead of keeping the first;
   - `toolreader note <sha> "…"` records human assertions;
   - the viewer shows per-file coverage and the unknown files.

   Demos: one commit by Codex plus hand edits, and one commit by two agents. No percentages.

2. **Verification proofs, locally:** `proof add` with tested SHA and procedure, a stale state in the viewer, media shown in the local viewer and in `ledger site` (metadata only, or bundled media). Validate with the existing private CI artifact path. Do teams look at it?
3. **Minimal hosted receiver:**
   - privacy policy and bundle review in the collector;
   - manual `toolreader push`;
   - device tokens;
   - per-artifact access, retention, deletion with tombstones, an audit log;
   - the viewer with repo and PR pages, and the GitHub App PR link;
   - one container image.
4. **Automation:** CI upload through OIDC with the strict policy, opt-in background `watch` upload (only after retries, duplicate uploads, policy changes and deletion are tested), automatic proof pickup, search, more session readers (Claude Code, Cursor), and experimental line-level estimates.

## Decisions for the developer

- **Before phase 3:** is it self-hosted first or SaaS first? Agent sessions often hold customer data, so self-hosting may be the easier sale. Is metadata-only the right default upload?
- **Hosting provider:** this can wait until phase 3. Any provider that runs a container with Postgres and object storage works.
- **The public website:** keep it on hold until the positioning above is agreed. The curated demo (four `codex exec` commits) works for either.
