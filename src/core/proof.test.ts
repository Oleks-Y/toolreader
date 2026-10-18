import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import type { Action, Entry, ThreadView } from "./domain.ts";
import {
  ProofArtifact,
  proofFileName,
  redactEntries,
  redactor,
  redactText,
  selectEntries,
} from "./proof.ts";

const decodeArtifact = Schema.decodeUnknownSync(Schema.fromJsonString(ProofArtifact));
const encodeArtifact = Schema.encodeSync(Schema.fromJsonString(ProofArtifact));

const action = (id: string, at: string, extra: Partial<Action> = {}): Action => ({
  type: "action",
  id,
  at,
  kind: "run",
  status: "ok",
  title: id,
  ...extra,
});
const user = (id: string, at: string): Entry => ({
  type: "message",
  id,
  at,
  role: "user",
  text: id,
});

describe("proof", () => {
  it("redacts each secret shape and keeps harmless prefixes", () => {
    const cases: Array<[string, string]> = [
      [
        "curl -H 'Authorization: Bearer abc.def.ghi' api",
        "curl -H 'Authorization: Bearer [redacted]' api",
      ],
      ["token ghp_0123456789abcdefghijABCDEFGHIJ012345 used", "token [redacted] used"],
      ["ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuv", "ANTHROPIC_API_KEY=[redacted]"],
      ["export DB_PASSWORD='hunter2'", "export DB_PASSWORD=[redacted]"],
      ['{"accessToken": "abc123", "name": "x"}', '{"accessToken": "[redacted]", "name": "x"}'],
      [
        "postgres://admin:s3cret@db.internal:5432/app",
        "postgres://[redacted]@db.internal:5432/app",
      ],
      ["https://x.dev/pair?token=abcdef&next=/", "https://x.dev/pair?token=[redacted]&next=/"],
      ["aws AKIAABCDEFGHIJKLMNOP key", "aws [redacted] key"],
      ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghijklmnop", "jwt [redacted jwt]"],
      [
        "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
        "[redacted private key]",
      ],
      ["xoxb-1234567890-abcdefghij slack", "[redacted] slack"],
    ];
    for (const [input, expected] of cases)
      assert.strictEqual(redactText(input).text, expected, input);
    assert.strictEqual(
      redactText("ls src && git status").count,
      0,
      "ordinary commands stay untouched",
    );
    assert.strictEqual(redactText("const tokenCount = 3; PASSWORD_MIN_LENGTH").count, 0);
  });

  it("changes nothing when it runs again on what it wrote", () => {
    for (const text of [
      "const TOKEN = [redacted];",
      "TOOLREADER_BACKEND_TOKEN: [redacted],",
      'SECRET=[redacted]x://a:b"',
      "export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123; echo done",
      // A JWT's shape, built here so no scanner mistakes the test for a leaked token.
      `curl -H 'Authorization: Bearer ${"eyJ"}${"x".repeat(14)}.${"y".repeat(14)}.${"z".repeat(14)}'`,
    ]) {
      const once = redactText(text).text;
      assert.strictEqual(redactText(once).text, once, text);
    }
  });

  it("redacts a private key cut off before its END line, through to the end of the text", () => {
    const head = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU";
    assert.deepStrictEqual(redactText(`cat key\n${head}\n… [512 bytes clipped] …\nAAAA`), {
      text: "cat key\n[redacted private key]",
      count: 1,
    });
    const whole = `${head}\n-----END OPENSSH PRIVATE KEY-----`;
    assert.deepStrictEqual(redactText(`${whole}\nnext\n${head}`), {
      text: "[redacted private key]\nnext\n[redacted private key]",
      count: 2,
    });
    // JSON-escaped, as a tool output quoting a key file holds it.
    assert.strictEqual(
      redactText(`{"key": "${head.replace("\n", "\\n")}`).text,
      '{"key": "[redacted private key]',
    );
    // Code that only names the header isn't a key.
    const code = 'if (s.startsWith("-----BEGIN RSA PRIVATE KEY-----")) parse(s);\nconst rest = 1;';
    assert.strictEqual(redactText(code).text, code);
    // Redacting again changes nothing: the backend admits what the CLI redacted.
    const once = redactText(`${head}\nmore`).text;
    assert.strictEqual(redactText(once).text, once);
  });

  it("redacts every free-text field, rewrites home, and drops outputs when asked", () => {
    const entries: Entry[] = [
      user("u1", "2026-01-01T00:00:00Z"),
      action("a1", "2026-01-01T00:00:01Z", {
        command: "export GITHUB_TOKEN=ghp_0123456789abcdefghijABCDEFGHIJ012345",
        output: "wrote /Users/me/.config/x with SECRET_KEY=abc",
        files: [
          {
            path: "/Users/me/app/.env",
            added: 1,
            removed: 0,
            isNew: false,
            isDeleted: false,
            diff: "@@ -0,0 +1,1 @@\n+API_KEY=zzz",
            truncated: true,
            addedKeys: ["API_KEY=zzz from the clipped tail"],
          },
        ],
      }),
      {
        type: "message",
        id: "m1",
        at: "2026-01-01T00:00:02Z",
        role: "assistant",
        text: "set STRIPE sk_live_abcdefghijklmnop1234",
      },
    ];
    const withOutputs = redactEntries(entries, { outputs: true, home: "/Users/me" });
    const a = withOutputs.entries[1] as Action;
    assert.strictEqual(a.command, "export GITHUB_TOKEN=[redacted]");
    assert.strictEqual(a.output, "wrote ~/.config/x with SECRET_KEY=[redacted]");
    assert.strictEqual(a.files?.[0]?.path, "~/app/.env");
    assert.strictEqual(a.files?.[0]?.diff, "@@ -0,0 +1,1 @@\n+API_KEY=[redacted]");
    // Matching keys never leave the machine.
    assert.isUndefined(a.files?.[0]?.addedKeys);
    assert.strictEqual((withOutputs.entries[2] as { text: string }).text, "set STRIPE [redacted]");
    assert.strictEqual(withOutputs.redactions, 5);

    const noOutputs = redactEntries(entries, { outputs: false });
    assert.isTrue(noOutputs.entries.every((e) => e.type !== "action" || e.output === undefined));
  });

  it("selects turns (1-based, as shown) or a time range, keeping each kept turn's prompt", () => {
    const entries: Entry[] = [
      user("u1", "2026-01-01T00:00:00Z"),
      action("a1", "2026-01-01T00:00:01Z"),
      user("u2", "2026-01-01T00:01:00Z"),
      action("a2", "2026-01-01T00:01:01Z"),
      action("a3", "2026-01-01T00:01:05Z"),
      user("u3", "2026-01-01T00:02:00Z"),
      action("a4", "2026-01-01T00:02:01Z"),
    ];
    const ids = (scope: Parameters<typeof selectEntries>[1]) =>
      selectEntries(entries, scope).map((e) => e.id);
    assert.deepStrictEqual(ids({ turns: { from: 2, to: 3 }, range: null }), [
      "u2",
      "a2",
      "a3",
      "u3",
      "a4",
    ]);
    assert.deepStrictEqual(
      ids({ turns: null, range: { from: "2026-01-01T00:01:04Z", to: "2026-01-01T00:02:01Z" } }),
      ["u2", "a3", "u3", "a4"],
    );
    assert.deepStrictEqual(ids({ turns: null, range: null }).length, entries.length);
  });

  it("round-trips through JSON with the same schema the viewer decodes", () => {
    const view: ThreadView = {
      thread: {
        id: "codex:01a0f6f7-c0dc",
        source: "codex",
        origin: "codex_exec",
        title: "Fix the sum bug!",
        projectId: "p",
        projectTitle: "demo",
        provider: "codex",
        status: "idle",
        archived: false,
        updatedAt: "2026-01-01T00:00:00Z",
        actionCount: 1,
        worktree: "/repo",
        head: "1:2",
      },
      entries: [action("a1", "2026-01-01T00:00:01Z", { output: "ok" })],
      labels: { a1: "Ran tests" },
    };
    const artifact: ProofArtifact = {
      formatVersion: 1,
      exportedAt: "2026-01-02T00:00:00Z",
      toolreaderVersion: "0.0.0",
      git: { branch: "fix/sum", head: "abc123", remote: null },
      scope: { turns: { from: 1, to: 1 }, range: null },
      outputs: "included",
      redactions: 0,
      view,
    };
    assert.deepStrictEqual(decodeArtifact(encodeArtifact(artifact)), artifact);
    assert.throws(() => decodeArtifact(JSON.stringify({ ...artifact, formatVersion: 2 })));
    assert.strictEqual(proofFileName(view, artifact.scope), "fix-the-sum-bug-01a0f6f7-t1.json");
  });

  it("hides the home directory as Claude Code spells it in a project folder's name", () => {
    const { clean } = redactor("/Users/alex");
    assert.strictEqual(
      clean("read ~/.claude/projects/-Users-alex-proj-toolreader/s1.jsonl and /Users/alex/x"),
      "read ~/.claude/projects/~-proj-toolreader/s1.jsonl and ~/x",
    );
  });
});
