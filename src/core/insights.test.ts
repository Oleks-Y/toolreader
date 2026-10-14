import { assert, describe, it } from "@effect/vitest";

import type { Action, Entry } from "./domain.ts";
import { detect, failureSignature, transitionError, type InsightThread } from "./insights.ts";

let n = 0;
const act = (extra: Partial<Action>): Entry => ({
  type: "action",
  id: `a${++n}`,
  at: `2026-01-01T10:${String(n).padStart(2, "0")}:00Z`,
  kind: "test",
  status: "failed",
  title: "vitest run",
  ...extra,
});
const thread = (id: string, entries: Entry[], parent: string | null = null): InsightThread => ({
  id,
  parent,
  entries,
});
const failing = (path: string, line: number) =>
  act({ output: `RUN v4\n FAIL ${path}:${line}\nTypeError: Cannot read 'x' of undefined` });

describe("insights", () => {
  it("makes one failure alike across paths, numbers, ids and quoted text", () => {
    assert.strictEqual(
      failureSignature(failing("src/a.test.ts", 12) as Action),
      failureSignature(failing("/repo/src/b.test.ts", 40) as Action),
    );
    assert.isNull(failureSignature(act({ output: "" }) as Action));
    // Claude Code's header on a failed command, and colors, aren't the failure.
    assert.strictEqual(
      failureSignature(
        act({
          output: "Error: Exit code 1\n\u001b[31mzsh: command not found: vp\u001b[0m",
        }) as Action,
      ),
      "test: zsh: command not found: vp",
    );
  });

  it("finds a failure in independent sessions, and says which recovered", () => {
    const found = detect([
      thread("s1", [failing("a.ts", 1), act({ status: "ok" })]),
      thread("s2", [failing("b.ts", 2)]),
      // A subagent of s2 counts with it, not as a third session.
      thread("s2-sub", [failing("c.ts", 3)], "s2"),
      // Not failures: a search with no match, a cancelled run.
      thread("s3", [
        act({ kind: "search", noMatch: true, output: "error: none" }),
        act({ status: "running", output: "TypeError: Cannot read 'x' of undefined" }),
      ]),
    ]).filter((d) => d.detector === "recurring-failure");
    assert.strictEqual(found.length, 1);
    const [f] = found;
    assert.strictEqual(f!.sessions, 2);
    assert.deepStrictEqual(f!.occurrences.map((o) => [o.threadId, o.recovered]).sort(), [
      ["s1", true],
      ["s2", false],
      ["s2-sub", false],
    ]);
    assert.include(f!.pattern, "1 were followed by a passing test");
  });

  it("finds a file read and not edited in independent sessions; one session isn't a pattern", () => {
    const read = (path: string) => act({ kind: "read", status: "ok", targets: [path] });
    const found = detect([
      thread("s1", [read("/home/x/repo/src/server/Store.ts"), read("README.md")]),
      thread("s2", [read("/home/x/wt/src/server/Store.ts")]),
      // Read and then edited: work on the file, not an investigation of it.
      thread("s3", [
        read("src/server/Store.ts"),
        act({
          kind: "edit",
          status: "ok",
          files: [
            { path: "src/server/Store.ts", added: 1, removed: 0, isNew: false, isDeleted: false },
          ],
        }),
      ]),
    ]).filter((d) => d.detector === "repeated-investigation");
    assert.deepStrictEqual(
      found.map((d) => [d.subject, d.sessions, d.key]),
      [["src/server/Store.ts", 2, "repeated-investigation:src/server/Store.ts"]],
    );
  });

  it("allows only the lifecycle's transitions", () => {
    assert.isNull(transitionError("detected", "proposed"));
    assert.isNull(transitionError("rejected", "proposed"));
    assert.include(transitionError("rejected", "accepted")!, "not accepted");
    assert.include(transitionError("evaluated", "proposed")!, "go to nothing");
  });
});
