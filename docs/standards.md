# Standards and neighbours: what toolreader should read, write or ignore

Checked on 14 October 2026. This is an investigation, not a commitment: nothing here is built,
and each "do" needs its own decision. Costs are engineer-days for one engineer who knows this
codebase.

| Standard            | What it is                                                                | Fit for toolreader                                                   | Cost                                   | Recommendation                                                    |
| ------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------- |
| Entire              | Git-native session capture, linked by a commit trailer                    | A strong link signal, and a source of sessions                       | Trailer: under 1 day. Reader: 3–6 days | Honor the trailer now. Build a reader if a pilot team uses Entire |
| Git AI              | Line authorship in git notes, with pointers to transcripts                | Overlaps content matching. Its notes could be read as declared links | 3–5 days                               | Not now. Line attribution as a metric is excluded                 |
| Agent-Logs-Url      | GitHub's trailer linking a Copilot coding agent commit to its session log | A reference only: the log needs GitHub access                        | Under 1 day                            | Record it as an external session reference                        |
| Agent Trace         | A draft open spec (v0.1.0, RFC) for linking code ranges to conversations  | A possible export format for toolreader's links                      | 2–4 days                               | Watch it. Export once the spec settles                            |
| OpenTelemetry GenAI | Semantic conventions for agent and tool spans                             | Could map observations to spans later                                | Unknown                                | No dependency while it is in Development status                   |
| agentsview          | A local multi-provider session viewer with a SQLite index                 | Not a standard: a baseline to compare against                        | Included in the benchmark              | Use it as the search benchmark's baseline                         |

## Entire

- **Storage.** [Entire](https://github.com/entireio/cli) (MIT, about 5.2k stars, v0.11.5 on
  14 October 2026) stores each checkpoint in your own repository. New repos use one ref per
  checkpoint, `refs/entire/checkpoints/<shard>/<id>`. Older repos use the `entire/checkpoints/v1`
  branch. A checkpoint holds `metadata.json` plus a redacted transcript per session.
  ([security and privacy](https://github.com/entireio/cli/blob/main/docs/security-and-privacy.md))
- **Commit links.** A checkpoint is linked to a commit by an `Entire-Checkpoint` trailer.
  ([sessions and checkpoints](https://github.com/entireio/cli/blob/main/docs/architecture/sessions-and-checkpoints.md))
- **Sessions with no commit.** Snapshots also cover sessions that change no files: research,
  planning, review. That's the same corpus the Insights detectors want.
- **Redaction.** Entire redacts secrets with entropy scoring, scanner engines and fixed rules
  before writing. Images pasted in Claude Code are stored unredacted, by design.
- **Fit: links.** The `Entire-Checkpoint` trailer is a declared link, as strong as toolreader's
  own `Agent-Session` trailer. Reading it means `history sync` takes the trailer as naming a
  session.
- **Fit: sessions.** Its transcripts are each agent's own format, so the existing Claude and
  Codex readers could parse them. A reader would list `refs/entire/checkpoints/*` and map
  checkpoints to sessions.
- **Overlap.** Entire captures prospectively, at commit time, which toolreader deliberately
  doesn't (S2: history only). Entire's record also carries no test-staleness or Insights logic,
  so the two complement each other rather than compete.
- **Do:** take `Entire-Checkpoint` as a trailer link (under 1 day). Build the checkpoint reader
  only if a pilot team already runs Entire (3–6 days).

## Git AI

- **What it does.** [git-ai](https://github.com/git-ai-project/git-ai) (Apache-2.0, about 2.8k
  stars) has agent hooks run `git ai checkpoint` after each edit. At commit time it packages
  line-level authorship into git notes (`refs/notes/ai`), with pointers to transcripts kept
  outside git. It supports about 14 agents and was a launch supporter of Agent Trace. Its notes
  are lost on merges made in the web UI. ([how it works](https://usegitai.com/docs/get-started/how-git-ai-works))
- **Fit.** Its line authorship answers "who wrote this line", which toolreader already
  approximates by content and the decision source excludes as a metric (S12). Its transcript
  pointers could serve as declared links, like the trailers above.
- **Do:** nothing now. If a pilot team uses Git AI, read its notes as declared links (3–5 days).
  Don't import its authorship numbers.

## Agent-Logs-Url

- **What it is.** Since 20 March 2026, commits from GitHub's Copilot coding agent carry an
  `Agent-Logs-Url` trailer that links permanently to the session log.
  ([GitHub changelog](https://github.blog/changelog/2026-03-20-trace-any-copilot-coding-agent-commit-to-its-session-logs))
- **Fit.** It covers that one cloud agent only. The log sits behind GitHub, so toolreader can't
  fetch or redact it. It's still a useful fact about a commit: "an agent wrote this, and its log
  is there".
- **Do:** record the URL on the commit record as an external session reference, and show it on
  the history page (under 1 day). Don't fetch the log.

## Agent Trace

- **What it is.** An open specification Cursor proposed in February 2026, at
  [agent-trace.dev](https://agent-trace.dev), version 0.1.0 with RFC status.
  - JSON trace records tie file or line ranges to conversations and contributors (human, AI,
    mixed, unknown).
  - It doesn't prescribe how traces are stored.
  - Thoughtworks' Technology Radar (April 2026) reports early adoption: Cline, OpenCode, Git AI.
    ([Thoughtworks Radar](https://www.thoughtworks.com/de-de/radar/platforms/agent-trace))
- **Fit.** toolreader's commit links (thread, turns, lines, how they were found) map onto trace
  records. Exporting them would let tools that read Agent Trace see toolreader's history.
- **Do:** wait for the spec to settle past its RFC, then add an export (2–4 days). Don't make
  Agent Trace the internal model: it records attribution, not checks, gaps or findings.

## OpenTelemetry GenAI semantic conventions

- **What it is.** Conventions that define `invoke_agent`, `execute_tool`, `create_agent` and
  other span types. Every `gen_ai.*` span, metric and attribute is still at Development stability.
  ([Dash0](https://www.dash0.com/knowledge/opentelemetry-genai-semantic-conventions-explained))
- **Status.** In June 2026 (v1.42.0) the conventions moved to a separate
  `semantic-conventions-genai` repository, which has no tagged release.
- **Who emits it.** Copilot in VS Code and Gemini CLI already export these spans.
- **Fit.** An observation (a tool call with its source and digest) maps naturally onto an
  `execute_tool` span. A turn maps onto `invoke_agent`, and subagents nest the same way.
- **Do:** nothing until the GenAI conventions reach a stable release. Then decide whether to
  export spans or to read spans from agents that emit them. Don't take a dependency on it before
  then.

## agentsview

- **What it is.** [agentsview](https://github.com/kenn-io/agentsview) (MIT, about 6.1k stars,
  v0.45.0 on 9 October 2026) is a local web and desktop viewer for many agents.
  - It keeps a SQLite index of sessions and exports to HTML or Gist.
  - With `--include-git-outcomes` it adds aggregate commit and line counts.
  - It doesn't link sessions to individual commits.
- **Fit.** It's not a standard. It's the obvious baseline for "search sessions locally, fast".
- **Do:** include it in the search benchmark (the W4 spike) as the baseline to beat on the same
  archive. It might also be worth contributing a T3 Code source adapter upstream, which is cheap
  and widens reach. That's a separate decision.

## What this changes in the plan

- **Cheapest wins:** the `Entire-Checkpoint` and `Agent-Logs-Url` trailers, each under a day.
  Neither is built yet.
- **Wait:** Agent Trace export (spec still an RFC) and OpenTelemetry (Development status).
- **No change:** Git AI's line authorship stays out, under the S12 exclusion.
