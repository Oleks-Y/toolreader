import { assert, describe, it } from "@effect/vitest";

import { findPrivate, type PrivacyRules } from "./privacy.ts";

const rules: PrivacyRules = {
  allowedPaths: ["/work/wordfreq", "/bin/zsh", "/usr/bin/env"],
  allowedEmails: ["demo@example.com", "agent@example.com"],
  allowedHosts: ["example.com"],
  forbidden: ["/Users/jdoe", "jdoe", "jdoe@corp.test", "Jane Doe", "jdoe-mbp", "secret-skill"],
};

const demo = {
  repo: "wordfreq",
  commits: [
    {
      commit: { sha: "75b17e85", subject: "chore: scaffold wordfreq CLI" },
      entry: {
        entries: [
          { command: "/bin/zsh -lc 'npm test'", output: "> wordfreq@1.0.0 test\n✔ 6 pass" },
          {
            title: "write bin/wordfreq.js",
            output: "#!/usr/bin/env node\nconst s = '/\\p{L}+/gu';",
          },
          { files: [{ path: "README.md", diff: "+See https://example.com/docs" }] },
          { output: "drwxr-xr-x@ 3 dev staff 96 Oct 1 15:22 .\ncd /work/wordfreq/bin" },
          { text: "Author: demo@example.com, regex /^\\d+$/ and 2/3 done" },
        ],
      },
    },
  ],
};

describe("findPrivate", () => {
  it("passes the allowed demo strings", () => {
    assert.deepStrictEqual(findPrivate(demo, rules), []);
  });

  it("finds a planted email, with where it is", () => {
    const findings = findPrivate({ a: [{ text: "ask jane@corp.test" }] }, rules);
    assert.deepStrictEqual(findings, [
      { path: "a[0].text", reason: "email", match: "jane@corp.test" },
    ]);
  });

  it("finds paths outside the repo, home-relative ones too", () => {
    const findings = findPrivate(
      { output: "cat /opt/notes/todo.md; ls ~/notes; ls /work/wordfreq-old" },
      rules,
    );
    assert.deepStrictEqual(
      findings.map((f) => f.match),
      ["/opt/notes/todo.md", "~/notes", "/work/wordfreq-old"],
    );
  });

  it("finds URLs off the allowlist", () => {
    const findings = findPrivate(
      { text: "see https://internal.corp.test/x. And https://example.com." },
      rules,
    );
    assert.deepStrictEqual(
      findings.map((f) => [f.reason, f.match]),
      [["url", "https://internal.corp.test/x"]],
    );
  });

  it("finds values from this machine, case-insensitively and in object keys", () => {
    const findings = findPrivate(
      {
        title: "applying the Secret-Skill skill",
        changes: { "/work/wordfreq/a.ts": { by: "JDOE on jdoe-mbp" } },
        notes: { "jane doe": "x" },
      },
      rules,
    );
    assert.deepStrictEqual(
      findings.map((f) => [f.path, f.match]),
      [
        ["title", "Secret-Skill"],
        ['changes["/work/wordfreq/a.ts"].by', "JDOE"],
        ['changes["/work/wordfreq/a.ts"].by', "jdoe-mbp"],
        ['notes["jane doe"]', "jane doe"],
      ],
    );
  });

  it("matches machine values only as whole words", () => {
    assert.deepStrictEqual(findPrivate({ text: "jdoes localjdoe" }, rules), []);
  });
});
