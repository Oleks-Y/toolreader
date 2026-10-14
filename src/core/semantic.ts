// Semantic grouping (plan D7): the repeated-investigation detector catches sessions that read the
// same files; this catches sessions asking the same question in other words or through other files.
// Each independent session is summarized (its prompts' first lines and the files it read; the
// backend does this, so no session body leaves it), a model groups the summaries by question, and
// groups spanning at least two independent sessions become `repeated-question` findings. People
// correct a group's members (`history insight members`); the held-out labels (insightsEval.ts)
// score it against the literal detectors before anyone relies on it. Pure; the model runs in
// server/Grouper.ts, only when asked for (`history insights --semantic`).
import * as Schema from "effect/Schema";

import type { Entry } from "./domain.ts";
import { MIN_SESSIONS, type Detection, type InsightThread } from "./insights.ts";

export const SessionSummary = Schema.Struct({
  /** The root session (a subagent counts with its parent). */
  id: Schema.String,
  /** The message entry each prompt came from, for citations. */
  prompts: Schema.Array(
    Schema.Struct({ entryId: Schema.String, at: Schema.String, text: Schema.String }),
  ),
  reads: Schema.Array(Schema.String),
});
export type SessionSummary = typeof SessionSummary.Type;

const PROMPTS = 5;
const READS = 20;
const TEXT = 300;

/** One summary per independent session: its first prompts' first lines and the files it read. */
export function summarize(threads: ReadonlyArray<InsightThread>): SessionSummary[] {
  const parentOf = new Map(threads.map((t) => [t.id, t.parent]));
  const root = (id: string) => {
    let at = id;
    const seen = new Set<string>();
    while (parentOf.get(at) && !seen.has(at)) {
      seen.add(at);
      at = parentOf.get(at)!;
    }
    return at;
  };
  const by = new Map<string, Entry[]>();
  for (const t of threads) by.set(root(t.id), [...(by.get(root(t.id)) ?? []), ...t.entries]);
  return [...by].map(([id, entries]) => ({
    id,
    prompts: entries
      .flatMap((e) =>
        e.type === "message" && e.role === "user" && e.text.trim()
          ? [{ entryId: e.id, at: e.at, text: e.text.trim().split("\n")[0]!.slice(0, TEXT) }]
          : [],
      )
      .slice(0, PROMPTS),
    reads: [
      ...new Set(
        entries.flatMap((e) => (e.type === "action" && e.kind === "read" ? (e.targets ?? []) : [])),
      ),
    ].slice(0, READS),
  }));
}

export const GroupingAnswer = Schema.Struct({
  groups: Schema.Array(
    Schema.Struct({
      /** The question the sessions share, in a sentence. */
      question: Schema.String,
      /** Summary ids. */
      members: Schema.Array(Schema.String),
    }),
  ),
});
export type GroupingAnswer = typeof GroupingAnswer.Type;

/** What the model is asked: group these sessions by the question they were trying to answer. */
export function groupingPrompt(summaries: ReadonlyArray<SessionSummary>): string {
  return [
    "You read summaries of coding-agent sessions in one repository.",
    "Group sessions that were trying to answer the SAME underlying question about the codebase,",
    "even when they phrase it differently or read different files to answer it.",
    "Only group sessions you are confident share a question; leave the rest out. A group has at",
    "least 2 members. Write each group's question in one plain sentence. Use the ids as given.",
    "",
    "Sessions (JSON):",
    JSON.stringify(
      summaries.map((s) => ({ id: s.id, prompts: s.prompts.map((p) => p.text), reads: s.reads })),
    ),
  ].join("\n");
}

/** The answer's groups as findings, ids the summaries don't have dropped, small groups too. */
export function detectionsFrom(
  answer: GroupingAnswer,
  summaries: ReadonlyArray<SessionSummary>,
): Detection[] {
  const byId = new Map(summaries.map((s) => [s.id, s]));
  return answer.groups.flatMap((g) => {
    const members = [...new Set(g.members)].filter((m) => byId.has(m)).sort();
    if (members.length < MIN_SESSIONS) return [];
    return [
      {
        // Keyed by the group's earliest member: stable while the group keeps it.
        key: `repeated-question:${members[0]}`,
        detector: "repeated-question" as const,
        subject: g.question.slice(0, 300),
        sessions: members.length,
        occurrences: members.flatMap((m) => {
          const p = byId.get(m)!.prompts[0];
          return p ? [{ threadId: m, entryId: p.entryId, at: p.at }] : [];
        }),
        pattern: `${members.length} independent sessions asked this, in their own words (grouped by a model).`,
        suggestion:
          "Check the group first (correct its members if needed). If they really share the question, answer it once where agents start: AGENTS.md, a doc, a test.",
      },
    ];
  });
}

/** JSON Schema for the model's answer (codex exec --output-schema). */
export const GROUPING_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["groups"],
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "members"],
        properties: {
          question: { type: "string" },
          members: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;
