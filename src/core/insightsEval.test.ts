import { assert, describe, it } from "@effect/vitest";

import type { Finding } from "./insights.ts";
import { evaluate, sampleRows, splitOf, type LabelRow } from "./insightsEval.ts";

const finding = (id: string, detector: Finding["detector"], sessions: number): Finding => ({
  key: `${detector}:${id}`,
  id,
  detector,
  subject: id,
  sessions,
  occurrences: [{ threadId: "t1", entryId: "a1", at: "2026-01-01T10:00:00Z" }],
  pattern: "p",
  suggestion: "s",
  status: "detected",
  events: [],
  detectedAt: "2026-01-01T10:00:00Z",
  updatedAt: "2026-01-01T10:00:00Z",
});

describe("insights evaluation", () => {
  it("samples each detector's findings into rows, each on a fixed side of the split", () => {
    const rows = sampleRows(
      [
        finding("f1", "recurring-failure", 3),
        finding("f2", "recurring-failure", 2),
        finding("r1", "repeated-investigation", 5),
      ],
      1,
    );
    assert.deepStrictEqual(
      rows.map((r) => [r.id, r.label, r.cites]),
      [
        ["f1", null, ["t1#a1"]],
        ["r1", null, ["t1#a1"]],
      ],
    );
    assert.strictEqual(splitOf("f1"), rows[0]!.split);
    // About one in five held out.
    const held = Array.from({ length: 1000 }, (_, i) => splitOf(`id${i}`)).filter(
      (s) => s === "heldout",
    );
    assert.isTrue(held.length > 150 && held.length < 250, String(held.length));
  });

  it("scores precision, novelty, recall from missed rows, and agreement", () => {
    const row = (
      id: string,
      label: LabelRow["label"],
      extra: Partial<LabelRow> = {},
    ): LabelRow => ({
      id,
      detector: "recurring-failure",
      subject: id,
      sessions: 2,
      pattern: "p",
      cites: [],
      split: "heldout",
      label,
      ...extra,
    });
    const [failures, investigations] = evaluate(
      [
        row("a", "real", { label2: "real" }),
        row("b", "known", { label2: "noise" }),
        row("c", "noise"),
        row("d", null),
        row("m", null, { missed: true }),
        row("x", "real", { split: "dev" }),
      ],
      "heldout",
    );
    assert.deepStrictEqual(
      [failures!.labelled, failures!.precision, failures!.novel, failures!.recall],
      [3, 2 / 3, 1 / 3, 2 / 3],
    );
    assert.deepStrictEqual([failures!.doubleLabelled, failures!.agreement], [2, 0.5]);
    // Nothing labelled: nothing claimed.
    assert.deepStrictEqual(
      [investigations!.labelled, investigations!.precision, investigations!.recall],
      [0, null, null],
    );
  });
});
