// Picks a Shiki language for each body the viewer shows. Pure, so it is unit-tested; "text" means
// "don't highlight".

const EXTENSIONS: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  jsonl: "json",
  md: "markdown",
  mdx: "mdx",
  py: "python",
  rs: "rust",
  go: "go",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  ex: "elixir",
  exs: "elixir",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ini: "ini",
  xml: "xml",
  html: "html",
  css: "css",
  scss: "scss",
  sql: "sql",
  graphql: "graphql",
  vue: "vue",
  svelte: "svelte",
  prisma: "prisma",
  tf: "hcl",
  lua: "lua",
};
const FILENAMES: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "make",
  ".env": "dotenv",
};

export function langFromPath(path: string): string {
  const name = (path.split("/").at(-1) ?? "").replace(/:\d.*$/, "").toLowerCase();
  if (FILENAMES[name]) return FILENAMES[name];
  if (name.startsWith("dockerfile")) return "dockerfile";
  const ext = name.includes(".") ? name.split(".").at(-1)! : "";
  return EXTENSIONS[ext] ?? "text";
}

/** Heredoc body language from what consumes it: `python3 - <<PY`, `node <<EOF`, `cat > x.ts <<EOF`. */
function heredocLang(line: string): string {
  const target = /(?:>|\btee\s+(?:-a\s+)?)\s*['"]?([^\s'"<>|;&]+)/.exec(
    line.slice(0, line.search(/<</)),
  )?.[1];
  if (target && /\b(cat|tee)\b/.test(line)) return langFromPath(target);
  if (/\bpython[\d.]*\b/.test(line)) return "python";
  if (/\b(tsx|ts-node)\b/.test(line)) return "typescript";
  if (/\b(node|bun|deno)\b/.test(line)) return "javascript";
  if (/\bruby\b/.test(line)) return "ruby";
  if (/\b(psql|sqlite3|mysql|duckdb)\b/.test(line)) return "sql";
  if (/\b(bash|sh|zsh)\b/.test(line)) return "bash";
  return "text";
}

export type Segment = { readonly lang: string; readonly text: string };

/** Splits a shell command into bash and heredoc bodies, each with its own language. */
export function commandSegments(command: string): Segment[] {
  const segments: Segment[] = [];
  let shell: string[] = [];
  let body: string[] = [];
  let heredoc: { end: string; lang: string } | null = null;
  const flush = (lang: string, lines: string[]) => {
    if (lines.length) segments.push({ lang, text: lines.join("\n") });
  };
  for (const line of command.split("\n")) {
    if (heredoc) {
      if (line.trim() === heredoc.end) {
        flush(heredoc.lang, body);
        body = [];
        heredoc = null;
        shell.push(line);
      } else body.push(line);
      continue;
    }
    shell.push(line);
    const m = /<<-?\s*['"]?([A-Za-z_][\w-]*)['"]?/.exec(line);
    if (m?.[1]) {
      flush("bash", shell);
      shell = [];
      heredoc = { end: m[1], lang: heredocLang(line) };
    }
  }
  if (heredoc) flush(heredoc.lang, body);
  flush("bash", shell);
  return segments;
}

/** Language for a tool output; `hint` is the language of the file it came from, if any. */
export function outputLang(text: string, hint = "text"): Segment {
  if (text.includes("\u001b[")) return { lang: "ansi", text };
  const trimmed = text.trim();
  if (/^[[{]/.test(trimmed) && /[\]}]$/.test(trimmed)) {
    try {
      return { lang: "json", text: JSON.stringify(JSON.parse(trimmed), null, 2) };
    } catch {
      // not JSON after all
    }
  }
  if (/^(diff --git |--- a\/|@@ -\d)/m.test(text) && /^[+-]/m.test(text))
    return { lang: "diff", text };
  return { lang: hint, text };
}
