// How `scripts/coverageEval.ts` scores an agent's answer about agent history. Against a stale
// copy (sessions that kept running after they were imported), an answer may say something
// didn't happen only with an as-of or coverage qualification in the same sentence; against a
// refreshed copy, it must name what happened (the fixture's required terms). Pure.
import * as Schema from "effect/Schema";

/** A fixture's `expect.json`: the question, and the terms a fresh answer must name. */
export const Expectation = Schema.Struct({
  question: Schema.String,
  /** Case-insensitive; each must appear in the answer against the refreshed copy. */
  required: Schema.Array(Schema.String),
});
export type Expectation = typeof Expectation.Type;

export const EVAL_MODES = ["stale", "fresh"] as const;
export type EvalMode = (typeof EVAL_MODES)[number];

/** Saying something didn't happen: "never", "no … happened/occurred/tested", "wasn't tested". */
const NEGATIVE =
  /\bnever\b|\bno\b[^.;:\n]{0,80}?\b(?:happened|occurred|took place|tested|testing|ran|run|done|performed)\b|\b(?:did not|didn't|was not|wasn't|were not|weren't|has not|hasn't|have not|haven't)\s+(?:been\s+)?(?:happen|occur|run|ran|test|tested|perform|performed|done)\b/i;
/** Saying how far the answer can see: as of when, what the copy covers. */
const QUALIFIED =
  /\bas of\b|\bcoverage\b|\bimported\b|\bsnapshot\b|\bmay be behind\b|\bstill running\b|\btaken_at\b|\bchecked_at\b|\bnot found in\b|\bin the (?:imported|stored) (?:copy|history)\b|\bat the time (?:it was|of) (?:read|import)/i;

/** An answer's sentences (and list items), as the negatives are judged one by one. */
const sentences = (text: string) =>
  text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

export type Score = { readonly pass: boolean; readonly reasons: ReadonlyArray<string> };

export function scoreAnswer(mode: EvalMode, answer: string, expect: Expectation): Score {
  if (mode === "stale") {
    const unqualified = sentences(answer).filter((s) => NEGATIVE.test(s) && !QUALIFIED.test(s));
    return {
      pass: unqualified.length === 0,
      reasons: unqualified.map((s) => `unqualified negative: ${s.slice(0, 200)}`),
    };
  }
  const lower = answer.toLowerCase();
  const missing = expect.required.filter((t) => !lower.includes(t.toLowerCase()));
  return { pass: missing.length === 0, reasons: missing.map((t) => `missing: ${t}`) };
}
