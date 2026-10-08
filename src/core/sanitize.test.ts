import { assert, describe, it } from "@effect/vitest";

import type { Action, Entry } from "./domain.ts";
import { LEDGER_FORMAT_VERSION, type LedgerEntry } from "./ledger.ts";
import { entryTexts, sanitizeEntry, textSanitizer, type SanitizeRules } from "./sanitize.ts";

const rules: SanitizeRules = {
  repo: "/home/me/proj/app",
  home: "/home/me",
  allow: ["~/.codex", "t3code"],
  names: ["me", "acme-backend", "jdoe", "t3code", "box"],
  spans: [{ text: "Clover Casino", kind: "organization" }],
};

const action = (id: string, fields: Partial<Action>): Action => ({
  type: "action",
  id,
  at: "2026-01-01T10:00:00Z",
  kind: "run",
  status: "ok",
  title: fields.command ?? "run",
  ...fields,
});

const entry = (entries: Entry[], labels: Record<string, string> = {}): LedgerEntry => ({
  formatVersion: LEDGER_FORMAT_VERSION,
  commit: {
    sha: "abc",
    subject: "fix: works on box",
    committedAt: "2026-01-01T10:00:00Z",
    patchId: null,
  },
  links: [
    {
      thread: {
        id: "t1",
        title: "help with acme-backend",
        source: "codex",
        provider: "codex",
        origin: null,
        parent: null,
      },
      role: "coder",
      via: "sha",
      reviewedSha: null,
      files: [],
      entries,
      labels,
    },
  ],
  unlinked: [],
  files: [],
  notes: [{ text: "fixed on box by hand", file: null, at: "2026-01-01T11:00:00Z" }],
  outputs: "included",
  redactions: 1,
});
/** The one link's history, as the tests read it. */
const only = (e: LedgerEntry) => e.links[0]!;

describe("textSanitizer", () => {
  const clean = textSanitizer(rules);

  it("writes the repo as . and keeps project paths, routes and system paths", () => {
    assert.deepStrictEqual(clean("cd /home/me/proj/app && cat ~/proj/app/src/a.ts"), {
      text: "cd . && cat ./src/a.ts",
      hits: 0,
    });
    assert.deepStrictEqual(clean("GET /api/threads via /usr/bin/env node"), {
      text: "GET /api/threads via /usr/bin/env node",
      hits: 0,
    });
  });

  it("finds names after a regex word boundary", () => {
    assert.strictEqual(
      clean(String.raw`grep -E '\bjdoe\b' log`).text,
      String.raw`grep -E '\b<private>\b' log`,
    );
  });

  it("reads URL-encoded paths too", () => {
    assert.deepStrictEqual(
      clean(
        "open /ledger?repo=%2Fhome%2Fme%2Fproj%2Fapp and ?r=%2Fhome%2Fme%2Fproj%2Facme-backend",
      ),
      { text: "open /ledger?repo=. and ?r=<path>", hits: 1 },
    );
    assert.deepStrictEqual(
      clean("?a=%2Fhome%2Fme%2Fclients%2Fwidget&b=%2Fhome%2Fme%2F.codex%2Fx"),
      {
        text: "?a=<path>&b=~%2F.codex%2Fx",
        hits: 1,
      },
    );
  });

  it("hides paths in home directories, except allowed prefixes", () => {
    assert.deepStrictEqual(
      clean("ls /home/me/proj/acme-backend/src && cat /Users/x/notes.md ~/.codex/sessions/a.jsonl"),
      { text: "ls <path> && cat <path> ~/.codex/sessions/a.jsonl", hits: 2 },
    );
  });

  it("hides local names inside compounds, emails, and agent spans, but not allowed names", () => {
    assert.deepStrictEqual(
      clean(
        "docker ps: acme-backend-db-1, ACME-BACKEND; mail jdoe@corp.com, not noreply@github.com",
      ),
      {
        text: "docker ps: <private>-db-1, <private>; mail <email>, not noreply@github.com",
        hits: 3,
      },
    );
    assert.deepStrictEqual(clean("built for Clover Casino, copied from t3code; boxes ok"), {
      text: "built for <organization>, copied from t3code; boxes ok",
      hits: 1,
    });
    assert.strictEqual(clean("write to alice@corp.com").text, "write to <email>");
  });
});

describe("sanitizeEntry", () => {
  const entries: Entry[] = [
    { type: "message", id: "m1", at: "t", role: "user", text: "fix the parser" },
    { type: "message", id: "m2", at: "t", role: "assistant", text: "unlike acme-backend, this…" },
    action("a1", { command: "ls -1 ..", output: "acme-backend\napp\n", clipped: 3 }),
    action("a2", { command: "cat /home/me/proj/acme-backend/.env" }),
    action("a3", {
      kind: "edit",
      title: "edit 2 files",
      files: [
        { path: "src/a.ts", added: 1, removed: 0, isNew: false, isDeleted: false, diff: "+x" },
        { path: "/home/me/notes.md", added: 1, removed: 0, isNew: true, isDeleted: false },
      ],
    }),
  ];
  const labels = { m2: "compared with acme-backend", a1: "listed projects", "fold:x": "explored" };

  it("anonymize keeps the structure and counts every hit", () => {
    const { entry: out, hits } = sanitizeEntry(entry(entries, labels), rules, "anonymize");
    assert.strictEqual(only(out).entries.length, 5);
    assert.strictEqual(out.commit.subject, "fix: works on <private>");
    assert.strictEqual(only(out).thread.title, "help with <private>");
    assert.strictEqual((only(out).entries[2] as Action).output, "<private>\napp\n");
    assert.strictEqual((only(out).entries[3] as Action).command, "cat <path>");
    assert.deepStrictEqual(
      (only(out).entries[4] as Action).files?.map((f) => f.path),
      ["src/a.ts", "<path>"],
    );
    assert.strictEqual(only(out).labels.m2, "compared with <private>");
    assert.strictEqual(out.notes[0]!.text, "fixed on <private> by hand");
    const withPaths = sanitizeEntry(
      {
        ...entry(entries, labels),
        files: [{ path: "customers/alice@private.org.txt", bucket: "attributed" }],
        links: [
          { ...entry(entries, labels).links[0]!, files: ["customers/alice@private.org.txt"] },
        ],
        notes: [{ text: "by hand", file: "customers/alice@private.org.txt", at: "t" }],
      },
      rules,
      "remove",
    ).entry;
    assert.notInclude(JSON.stringify(withPaths), "alice@private.org", "paths are sanitized too");
    assert.strictEqual(withPaths.files[0]!.path, only(withPaths).files[0]);
    assert.strictEqual(hits, 9);
    assert.strictEqual(out.redactions, 10);
  });

  it("remove drops what carries a hit: messages, actions, outputs, files and their labels", () => {
    const { entry: out } = sanitizeEntry(entry(entries, labels), rules, "remove");
    assert.deepStrictEqual(
      only(out).entries.map((e) => e.id),
      ["m1", "a1", "a3"],
    );
    const ls = only(out).entries[1] as Action;
    assert.strictEqual(ls.output, undefined);
    assert.strictEqual(ls.clipped, undefined);
    assert.deepStrictEqual(
      (only(out).entries[2] as Action).files?.map((f) => f.path),
      ["src/a.ts"],
    );
    assert.deepStrictEqual(only(out).labels, { a1: "listed projects", "fold:x": "explored" });
    assert.deepStrictEqual(out.notes, [], "a note that names something private goes");
    assert.strictEqual(out.commit.subject, "fix: works on <private>");
  });

  it("entryTexts lists each distinct free-text string once", () => {
    const texts = entryTexts([entry(entries, labels), entry(entries.slice(0, 1))]);
    assert.include(texts, "fix the parser");
    assert.include(texts, "+x");
    assert.include(texts, "explored");
    assert.strictEqual(texts.filter((t) => t === "fix the parser").length, 1);
  });
});
