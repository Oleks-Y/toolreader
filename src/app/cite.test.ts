import { expect, it } from "@effect/vitest";

import { citeOf, parseCite } from "./cite.ts";

it("reads back the citation a hit writes, and nothing else", () => {
  const hit = { threadId: "codex:a#b", entryId: "t1", version: "abc123" } as never;
  expect(parseCite(citeOf(hit))).toEqual({
    threadId: "codex:a#b",
    entryId: "t1",
    version: "abc123",
  });
  expect(parseCite("codex:a#t1")).toEqual({ threadId: "codex:a", entryId: "t1" });
  expect(parseCite("#t1@abc")).toBeNull();
});
