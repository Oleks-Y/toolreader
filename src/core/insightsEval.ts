// The Insights detectors' labelled evaluation: findings sampled into rows a person labels
// (`history insights sample`), and the labels scored per detector (`history insights evaluate`).
// A row's split is fixed by its id, about one in five held out, so tuning on the rest never sees
// the held-out ones. A person adds the patterns the detectors missed as rows of their own
// (`missed: true`), which is what recall needs. A second labeller's `label2` gives agreement.
import * as Schema from "effect/Schema";

import { DETECTORS, type Finding } from "./insights.ts";

/**
 * `real`: a pattern worth acting on; `known`: real, but the reader knew it already; `noise`:
 * generic, obvious or wrong.
 */
export const LABELS = ["real", "known", "noise"] as const;
export type Label = (typeof LABELS)[number];

export const LabelRow = Schema.Struct({
  id: Schema.String,
  detector: Schema.Literals(DETECTORS),
  subject: Schema.String,
  sessions: Schema.Number,
  pattern: Schema.String,
  /** thread#entry, the first few. */
  cites: Schema.Array(Schema.String),
  split: Schema.Literals(["dev", "heldout"]),
  label: Schema.NullOr(Schema.Literals(LABELS)),
  label2: Schema.optional(Schema.NullOr(Schema.Literals(LABELS))),
  /** A pattern a person found that no detector did. */
  missed: Schema.optional(Schema.Boolean),
  note: Schema.optional(Schema.String),
});
export type LabelRow = typeof LabelRow.Type;

/** A stable split from the id: the same finding is always on the same side. */
export const splitOf = (id: string): LabelRow["split"] => {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 5 === 0 ? "heldout" : "dev";
};

/** Up to `perDetector` findings of each detector, most sessions first, as rows to label. */
export function sampleRows(findings: ReadonlyArray<Finding>, perDetector: number): LabelRow[] {
  return DETECTORS.flatMap((d) =>
    findings
      .filter((f) => f.detector === d)
      .slice(0, perDetector)
      .map((f) => ({
        id: f.id,
        detector: f.detector,
        subject: f.subject,
        sessions: f.sessions,
        pattern: f.pattern,
        cites: f.occurrences.slice(0, 3).map((o) => `${o.threadId}#${o.entryId}`),
        split: splitOf(f.id),
        label: null,
      })),
  );
}

export type DetectorScore = {
  readonly detector: (typeof DETECTORS)[number];
  readonly labelled: number;
  /** (real + known) / labelled: how often a finding is a real pattern. */
  readonly precision: number | null;
  /** real / labelled: how often it tells the reader something new. */
  readonly novel: number | null;
  /** Found real ones / (found real ones + missed ones); null without any missed rows. */
  readonly recall: number | null;
  /** Rows both labellers labelled, and the share they agree on. */
  readonly doubleLabelled: number;
  readonly agreement: number | null;
};

const ratio = (n: number, d: number) => (d === 0 ? null : n / d);

/** Scores per detector over one split's labelled rows. */
export function evaluate(
  rows: ReadonlyArray<LabelRow>,
  split: LabelRow["split"] | "all",
): DetectorScore[] {
  const inSplit = rows.filter((r) => split === "all" || r.split === split);
  return DETECTORS.map((detector) => {
    const mine = inSplit.filter((r) => r.detector === detector);
    const found = mine.filter((r) => !r.missed && r.label !== null);
    const real = found.filter((r) => r.label === "real" || r.label === "known").length;
    const missed = mine.filter((r) => r.missed).length;
    const both = found.filter((r) => r.label2 !== undefined && r.label2 !== null);
    return {
      detector,
      labelled: found.length,
      precision: ratio(real, found.length),
      novel: ratio(found.filter((r) => r.label === "real").length, found.length),
      recall: missed === 0 ? null : ratio(real, real + missed),
      doubleLabelled: both.length,
      agreement: ratio(both.filter((r) => r.label === r.label2).length, both.length),
    };
  });
}
