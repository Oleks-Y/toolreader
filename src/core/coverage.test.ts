import { assert, describe, it } from "@effect/vitest";

import { readsFor } from "./coverage.ts";
import type { Entry } from "./domain.ts";

const prompt = (id: string, at: string): Entry => ({
  type: "message",
  id,
  at,
  role: "user",
  text: "go",
});
const read = (id: string, at: string, targets: string[]): Entry => ({
  type: "action",
  id,
  at,
  kind: "read",
  status: "ok",
  title: `read ${targets.join(", ")}`,
  targets,
});

describe("readsFor", () => {
  const entries = [
    prompt("u0", "2026-01-01T09:00:00Z"),
    read("r0", "2026-01-01T09:01:00Z", ["README.md"]),
    prompt("u1", "2026-01-01T10:00:00Z"),
    read("r1", "2026-01-01T10:01:00Z", ["src/b.ts", "src/a.ts"]),
    read("r2", "2026-01-01T10:02:00Z", ["src/a.ts"]),
    // After the commit: not something it rested on.
    read("r3", "2026-01-01T12:00:00Z", ["src/late.ts"]),
  ];

  it("lists what the linked turns read up to the commit, once each", () => {
    assert.deepStrictEqual(
      readsFor({ entries, turns: ["u1"], committedAt: "2026-01-01T11:00:00Z" }),
      { paths: ["src/a.ts", "src/b.ts"], more: 0 },
    );
    // A trailer link (no turns): from the session's start.
    assert.deepStrictEqual(
      readsFor({ entries, turns: [], committedAt: "2026-01-01T11:00:00Z" }).paths,
      ["README.md", "src/a.ts", "src/b.ts"],
    );
  });

  it("keeps the first 200 and counts the rest", () => {
    const many = Array.from({ length: 250 }, (_, i) => `f${String(i).padStart(3, "0")}.ts`);
    const r = readsFor({
      entries: [prompt("u1", "2026-01-01T10:00:00Z"), read("r", "2026-01-01T10:01:00Z", many)],
      turns: ["u1"],
      committedAt: "2026-01-01T11:00:00Z",
    });
    assert.deepStrictEqual([r.paths.length, r.more], [200, 50]);
  });
});
