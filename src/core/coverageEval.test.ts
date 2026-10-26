import { assert, describe, it } from "@effect/vitest";

import { scoreAnswer } from "./coverageEval.ts";

const expect = { question: "What staging testing happened?", required: ["staging", "checkout"] };

describe("scoreAnswer", () => {
  it("fails a stale answer that says something never happened, without saying as of when", () => {
    for (const answer of [
      "No sandbox or staging testing happened in this thread.",
      "The agent never tested on staging.",
      "Staging wasn't tested.",
      "- no staging QA was performed",
    ])
      assert.isFalse(scoreAnswer("stale", answer, expect).pass, answer);
  });

  it("passes a stale answer whose negatives say how far it can see", () => {
    for (const answer of [
      "As of the import at 2026-10-25T23:50Z, no staging testing happened; the thread was still running.",
      "No staging test is in the imported copy, which may be behind the live session.",
      "The thread ran unit tests. Coverage lists it as running, so later staging work may be missing.",
    ])
      assert.isTrue(scoreAnswer("stale", answer, expect).pass, answer);
    // One qualified sentence doesn't excuse another.
    const mixed = scoreAnswer(
      "stale",
      "As of the import, the copy may be behind. Staging was never tested.",
      expect,
    );
    assert.deepStrictEqual(mixed, {
      pass: false,
      reasons: ["unqualified negative: Staging was never tested."],
    });
  });

  it("fails a fresh answer that misses a required term, in any case", () => {
    assert.deepStrictEqual(scoreAnswer("fresh", "QA ran the Checkout flow on STAGING.", expect), {
      pass: true,
      reasons: [],
    });
    assert.deepStrictEqual(scoreAnswer("fresh", "QA ran on staging.", expect), {
      pass: false,
      reasons: ["missing: checkout"],
    });
  });
});
