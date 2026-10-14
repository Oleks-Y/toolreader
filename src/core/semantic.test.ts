import { assert, describe, it } from "@effect/vitest";

import type { Entry } from "./domain.ts";
import { corrected, type Detection } from "./insights.ts";
import { detectionsFrom, groupingPrompt, summarize } from "./semantic.ts";

const prompt = (id: string, text: string): Entry => ({
  type: "message",
  id,
  at: "2026-01-01T10:00:00Z",
  role: "user",
  text,
});
const read = (id: string, path: string): Entry => ({
  type: "action",
  id,
  at: "2026-01-01T10:01:00Z",
  kind: "read",
  status: "ok",
  title: `read ${path}`,
  targets: [path],
});

describe("semantic grouping", () => {
  const threads = [
    {
      id: "s1",
      parent: null,
      entries: [
        prompt("p1", "why do retries come back undefined?\nmore"),
        read("r1", "src/retry.ts"),
      ],
    },
    { id: "s1-sub", parent: "s1", entries: [read("r2", "src/config.ts")] },
    { id: "s2", parent: null, entries: [prompt("p2", "retry count is missing, where is it set")] },
    { id: "s3", parent: null, entries: [prompt("p3", "rename the CLI flag")] },
  ];

  it("summarizes each independent session: first prompt lines and files read, subagents included", () => {
    const summaries = summarize(threads);
    assert.deepStrictEqual(
      summaries.map((s) => [s.id, s.prompts.map((p) => p.text), s.reads]),
      [
        ["s1", ["why do retries come back undefined?"], ["src/retry.ts", "src/config.ts"]],
        ["s2", ["retry count is missing, where is it set"], []],
        ["s3", ["rename the CLI flag"], []],
      ],
    );
    assert.include(groupingPrompt(summaries), "SAME underlying question");
    assert.notInclude(groupingPrompt(summaries), "more");
  });

  it("keeps groups of two or more known sessions, keyed by their earliest member", () => {
    const found = detectionsFrom(
      {
        groups: [
          { question: "Where is the retry count set?", members: ["s2", "s1", "nope"] },
          { question: "Alone", members: ["s3"] },
        ],
      },
      summarize(threads),
    );
    assert.deepStrictEqual(
      found.map((d) => [
        d.key,
        d.detector,
        d.sessions,
        d.occurrences.map((o) => [o.threadId, o.entryId]),
      ]),
      [
        [
          "repeated-question:s1",
          "repeated-question",
          2,
          [
            ["s1", "p1"],
            ["s2", "p2"],
          ],
        ],
      ],
    );
  });

  it("applies people's corrections to a group's members", () => {
    const d: Detection = {
      key: "repeated-question:s1",
      detector: "repeated-question",
      subject: "q",
      sessions: 2,
      occurrences: [
        { threadId: "s1", entryId: "p1", at: "" },
        { threadId: "s2", entryId: "p2", at: "" },
      ],
      pattern: "p",
      suggestion: "s",
    };
    const c = corrected(d, { add: ["s3"], remove: ["s2"] });
    assert.deepStrictEqual([c.sessions, c.occurrences.map((o) => o.threadId)], [2, ["s1", "s3"]]);
    assert.strictEqual(corrected(d, undefined), d);
  });
});
