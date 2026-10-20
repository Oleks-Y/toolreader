import { expect, it } from "@effect/vitest";

import type { Finding, FindingEvent } from "../core/insights.ts";
import { nextSteps, recovery, reopened, sinceChange, tabOf } from "./findings.ts";

const event = (from: string, to: string, at: string, by = "github:alex"): FindingEvent =>
  ({ from, to, by, at, why: `${to} why` }) as FindingEvent;
const finding = (over: Partial<Finding>): Finding => ({
  key: "k",
  detector: "recurring-failure",
  subject: "s",
  sessions: 3,
  occurrences: [
    { threadId: "a", entryId: "1", at: "2026-01-01T00:00:00Z", recovered: true },
    { threadId: "b", entryId: "1", at: "2026-01-05T00:00:00Z", recovered: false },
    { threadId: "c", entryId: "1", at: "2026-01-09T00:00:00Z" },
  ],
  pattern: "p",
  suggestion: "s",
  id: "f1",
  status: "detected",
  events: [],
  detectedAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...over,
});

it("offers the lifecycle's next steps, without modifying", () => {
  expect(nextSteps("proposed").map((s) => s.to)).toEqual(["accepted", "rejected"]);
  expect(nextSteps("evaluated")).toEqual([]);
  expect([tabOf("monitoring"), tabOf("detected"), tabOf("evaluated")]).toEqual([
    "accepted",
    "open",
    "done",
  ]);
});

it("says when the detector brought a rejected finding back, and what it overrode", () => {
  const rejected = event("proposed", "rejected", "2026-01-02T00:00:00Z");
  const back = event("rejected", "proposed", "2026-01-06T00:00:00Z", "detector");
  expect(reopened(finding({ events: [rejected, back] }))).toEqual({
    why: back.why,
    rejection: rejected,
  });
  expect(reopened(finding({ events: [rejected, event("rejected", "proposed", "x")] }))).toBeNull();
});

it("counts sessions on each side of the recorded change, and who recovered", () => {
  const f = finding({ events: [event("accepted", "implemented", "2026-01-04T00:00:00Z")] });
  expect(sinceChange(f)).toMatchObject({ after: 2, before: 1 });
  expect(sinceChange(finding({}))).toBeNull();
  expect(recovery(f)).toEqual({ recovered: 1, unresolved: 2 });
});
