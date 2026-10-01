import { assert, describe, it } from "@effect/vitest";

import { commandSegments, langFromPath, outputLang } from "./codeLang.ts";

describe("codeLang", () => {
  it("maps files to languages", () => {
    assert.deepStrictEqual(
      [
        "src/a.ts",
        "x.test.tsx",
        "Dockerfile.staff-invite-tests",
        "compose.yml",
        "README.md",
        "a.ts:12-40",
        "notes",
      ].map(langFromPath),
      ["typescript", "tsx", "dockerfile", "yaml", "markdown", "typescript", "text"],
    );
  });

  it("highlights heredoc bodies in their own language", () => {
    const command = [
      "python3 - <<'PY'",
      "from pathlib import Path",
      "print(Path('.').resolve())",
      "PY",
      "cat > src/x.ts <<EOF",
      "export const x = 1;",
      "EOF",
      "git diff --stat",
    ].join("\n");
    assert.deepStrictEqual(
      commandSegments(command).map((s) => [s.lang, s.text.split("\n").length]),
      [
        ["bash", 1],
        ["python", 2],
        ["bash", 2],
        ["typescript", 1],
        ["bash", 2],
      ],
    );
    assert.deepStrictEqual(commandSegments("rg -n foo src"), [
      { lang: "bash", text: "rg -n foo src" },
    ]);
  });

  it("sniffs outputs: JSON is pretty-printed, diffs and ANSI are detected, else the file hint", () => {
    assert.deepStrictEqual(outputLang('{"a":[1,2]}'), {
      lang: "json",
      text: '{\n  "a": [\n    1,\n    2\n  ]\n}',
    });
    assert.strictEqual(
      outputLang("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b").lang,
      "diff",
    );
    assert.strictEqual(outputLang("\u001b[32m✓ ok\u001b[0m").lang, "ansi");
    assert.strictEqual(outputLang("{not json}").lang, "text");
    assert.strictEqual(outputLang("export const a = 1;", "typescript").lang, "typescript");
  });
});
