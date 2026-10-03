import type { ActionKind } from "./domain.ts";

// --- Copied from t3code apps/web/src/session-logic.ts (unwrapKnownShellCommandWrapper & helpers). ---

function trimMatchingOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    const unquoted = trimmed.slice(1, -1).trim();
    if (unquoted.length === 0) return trimmed;
    // Not in t3code: undo the escaping a double-quoted wrapper adds.
    return trimmed.startsWith('"') ? unquoted.replace(/\\(["\\$`])/g, "$1") : unquoted;
  }
  return trimmed;
}

function executableBasename(value: string): string | null {
  const trimmed = trimMatchingOuterQuotes(value);
  if (trimmed.length === 0) return null;
  const last = trimmed.replace(/\\/g, "/").split("/").at(-1)?.trim() ?? "";
  return last.length > 0 ? last.toLowerCase() : null;
}

function splitExecutableAndRest(value: string): { executable: string; rest: string } | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const closeIndex = trimmed.indexOf(trimmed.charAt(0), 1);
    if (closeIndex <= 0) return null;
    return {
      executable: trimmed.slice(0, closeIndex + 1),
      rest: trimmed.slice(closeIndex + 1).trim(),
    };
  }
  const firstWhitespace = trimmed.search(/\s/);
  if (firstWhitespace < 0) return { executable: trimmed, rest: "" };
  return {
    executable: trimmed.slice(0, firstWhitespace),
    rest: trimmed.slice(firstWhitespace).trim(),
  };
}

const SHELL_WRAPPER_SPECS = [
  {
    executables: ["pwsh", "pwsh.exe", "powershell", "powershell.exe"],
    wrapperFlagPattern: /(?:^|\s)-command\s+/i,
  },
  { executables: ["cmd", "cmd.exe"], wrapperFlagPattern: /(?:^|\s)\/c\s+/i },
  { executables: ["bash", "sh", "zsh"], wrapperFlagPattern: /(?:^|\s)-(?:l)?c\s+/i },
] as const;

export function unwrapShell(value: string): string {
  const split = splitExecutableAndRest(value);
  if (!split || split.rest.length === 0) return value;
  const shell = executableBasename(split.executable);
  const spec =
    shell && SHELL_WRAPPER_SPECS.find((s) => (s.executables as readonly string[]).includes(shell));
  if (!spec) return value;
  const match = spec.wrapperFlagPattern.exec(split.rest);
  if (!match) return value;
  const command = shellWord(split.rest.slice(match.index + match[0].length));
  return command.length > 0 ? command : value;
}

// --- End of copied code. ---

/** The script argument of `sh -c`: one shell word (e.g. `'a '"'"'b'"'"''`), unquoted as the shell would. */
function shellWord(value: string): string {
  const tokens = tokenize(value.trim());
  const only = tokens.length === 1 ? tokens[0] : undefined;
  return only && "word" in only ? only.word : trimMatchingOuterQuotes(value);
}

/** Drops heredoc bodies so they aren't parsed as commands. */
function stripHeredocs(command: string): string {
  const lines = command.split("\n");
  const out: string[] = [];
  let delimiter: string | null = null;
  for (const line of lines) {
    if (delimiter !== null) {
      if (line.trim() === delimiter) delimiter = null;
      continue;
    }
    out.push(line);
    const m = /<<-?\s*['"]?([A-Za-z_][\w-]*)['"]?/.exec(line);
    if (m?.[1]) delimiter = m[1];
  }
  return out.join("\n");
}

type Token = { word: string } | { op: string };

/** Minimal POSIX-ish tokenizer: quotes, escapes, and the operators && || ; | & and newlines. */
function tokenize(command: string): Token[] {
  const tokens: Token[] = [];
  let word = "";
  let inWord = false;
  const flush = () => {
    if (inWord) tokens.push({ word });
    word = "";
    inWord = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if ((c === "$" && command[i + 1] === "(") || c === "`") {
      // A command substitution is part of its word, whatever it contains.
      const end = substitutionEnd(command, i);
      word += command.slice(i, end);
      inWord = true;
      i = end - 1;
    } else if (c === "'") {
      const end = command.indexOf("'", i + 1);
      word += command.slice(i + 1, end < 0 ? undefined : end);
      inWord = true;
      i = end < 0 ? command.length : end;
    } else if (c === '"') {
      i++;
      while (i < command.length && command[i] !== '"') {
        if ((command[i] === "$" && command[i + 1] === "(") || command[i] === "`") {
          // A substitution may hold its own quotes: `"$(printf ")")"`.
          const end = substitutionEnd(command, i);
          word += command.slice(i, end);
          i = end;
          continue;
        }
        // POSIX: inside double quotes a backslash only escapes $ ` " \ and newline.
        if (command[i] === "\\" && /["\\$`\n]/.test(command[i + 1] ?? "")) i++;
        word += command[i];
        i++;
      }
      inWord = true;
    } else if (c === "\\" && i + 1 < command.length) {
      if (command[i + 1] !== "\n") word += command[i + 1];
      inWord = true;
      i++;
    } else if (c === "&" && command[i + 1] === "&") {
      flush();
      tokens.push({ op: "&&" });
      i++;
    } else if (c === "|" && command[i + 1] === "|") {
      flush();
      tokens.push({ op: "||" });
      i++;
    } else if (
      c === ";" ||
      c === "\n" ||
      c === "|" ||
      (c === "&" && command[i - 1] !== ">" && command[i + 1] !== ">")
    ) {
      flush();
      tokens.push({ op: c === "\n" ? ";" : c });
    } else if (c === " " || c === "\t") {
      flush();
    } else {
      word += c;
      inWord = true;
    }
  }
  flush();
  return tokens;
}

/** Index just past the `$(…)` or `` `…` `` starting at `start`, skipping quoted parens. */
function substitutionEnd(command: string, start: number): number {
  if (command[start] === "`") {
    for (let i = start + 1; i < command.length; i++) {
      if (command[i] === "\\") i++;
      else if (command[i] === "`") return i + 1;
    }
    return command.length;
  }
  let depth = 0;
  for (let i = start + 1; i < command.length; i++) {
    const c = command[i]!;
    if (c === "\\") i++;
    else if (c === "'") {
      const close = command.indexOf("'", i + 1);
      if (close < 0) return command.length;
      i = close;
    } else if (c === '"') i = doubleQuoteEnd(command, i) - 1;
    else if (c === "`") i = substitutionEnd(command, i) - 1;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
  }
  return command.length;
}

/** Index just past the double-quoted string opening at `start`: skips escapes and substitutions. */
function doubleQuoteEnd(command: string, start: number): number {
  for (let i = start + 1; i < command.length; i++) {
    const c = command[i]!;
    if (c === "\\") i++;
    else if ((c === "$" && command[i + 1] === "(") || c === "`")
      i = substitutionEnd(command, i) - 1;
    else if (c === '"') return i + 1;
  }
  return command.length;
}

/** Splits a command into pipelines (by && || ; &), each a list of stages (by |), each a word list. */
export function splitCommand(command: string): string[][][] {
  const pipelines: string[][][] = [];
  let stages: string[][] = [];
  let words: string[] = [];
  const endStage = () => {
    if (words.length) stages.push(words);
    words = [];
  };
  const endPipeline = () => {
    endStage();
    if (stages.length) pipelines.push(stages);
    stages = [];
  };
  for (const t of tokenize(stripHeredocs(command))) {
    if ("word" in t) words.push(t.word);
    else if (t.op === "|") endStage();
    else endPipeline();
  }
  endPipeline();
  return pipelines;
}

/** `isSearch`: exit code 1 means "no match" (rg/grep), not failure. */
export type Part = { kind: ActionKind; title: string; targets?: string[]; isSearch?: boolean };

/** A chain takes the kind of its strongest part, e.g. `cd x && pnpm i && pnpm test` is a test. */
const KIND_RANK: Record<ActionKind, number> = {
  read: 0,
  search: 1,
  tool: 2,
  agent: 3,
  web: 4,
  setup: 5,
  edit: 6,
  run: 7,
  build: 8,
  test: 9,
  docker: 10,
  git: 11,
};
export const strongestKind = (kinds: ActionKind[]): ActionKind =>
  kinds.reduce<ActionKind>((a, b) => (KIND_RANK[b] > KIND_RANK[a] ? b : a), "read");

const DROP = new Set([
  "cd",
  "pushd",
  "popd",
  "export",
  "set",
  "unset",
  "true",
  ":",
  "source",
  ".",
  "sleep",
  "echo",
  "printf",
]);
const READERS = new Set([
  "cat",
  "head",
  "tail",
  "nl",
  "wc",
  "less",
  "bat",
  "file",
  "stat",
  "jq",
  "diff",
  "cmp",
  "md5",
  "shasum",
  "realpath",
  "readlink",
  "which",
  "pwd",
  "date",
  "du",
  "df",
]);
const SEARCHERS = new Set(["rg", "grep", "egrep", "ag", "ack", "git-grep"]);
const LISTERS = new Set(["ls", "find", "fd", "tree"]);
const GIT_READ = new Set([
  "status",
  "log",
  "diff",
  "show",
  "rev-parse",
  "rev-list",
  "blame",
  "ls-files",
  "grep",
  "fetch",
  "describe",
  "shortlog",
  "reflog",
  "config",
  "remote",
  "merge-base",
  "cat-file",
  "ls-remote",
]);
const GH_WRITE =
  /^(create|merge|comment|edit|close|reopen|ready|review|delete|lock|rerun|cancel|run)$/;
/** Flags whose next word is a value, not a positional arg. */
const VALUE_FLAGS = new Set([
  "-g",
  "--glob",
  "-e",
  "-t",
  "--type",
  "-A",
  "-B",
  "-C",
  "-m",
  "--max-count",
  "-f",
  "--context",
  "--max-depth",
  "-d",
  "--include",
  "--exclude",
  "-name",
  "-type",
  "-maxdepth",
  "-mindepth",
  "-path",
  "-iname",
  "--jq",
  "-q",
]);

const short = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function positional(args: string[], valueFlags = VALUE_FLAGS): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("-")) {
      if (valueFlags.has(a)) i++;
      continue;
    }
    if (/^\d?>>?$|^<$/.test(a)) {
      i++;
      continue;
    }
    if (/^\d?>(?:&|\/dev\/null)/.test(a) || /^\d+$/.test(a)) continue;
    out.push(a);
  }
  return out;
}

/** Returns the redirect target of `> file` / `>> file` (ignoring /dev/null and fd dups). */
function redirectTarget(words: string[]): string | null {
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const m = /^(?:\d?)(>>?)(.*)$/.exec(w);
    if (!m || m[2]?.startsWith("&")) continue;
    const target = m[2] || words[i + 1];
    if (target && target !== "/dev/null" && !target.startsWith("&")) return target;
  }
  return null;
}

function humanizeStage(words: string[]): Part | null {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][\w]*=/.test(words[i]!)) i++; // env assignments
  const argv = words.slice(i);
  if (argv[0] === "command" && /^-[vV]$/.test(argv[1] ?? ""))
    return { kind: "read", title: `which ${argv.slice(2).join(" ")}` };
  if (argv[0] === "env" || argv[0] === "time" || argv[0] === "command" || argv[0] === "exec")
    argv.shift();
  const exe = argv[0];
  if (!exe) return null;
  const cmd = exe.replace(/^.*\//, "");
  const args = argv.slice(1);
  const written = redirectTarget(argv);

  if (DROP.has(cmd))
    return written ? { kind: "edit", title: `write ${written}`, targets: [written] } : null;
  if (written && (cmd === "cat" || cmd === "tee" || cmd === "printf")) {
    return { kind: "edit", title: `write ${written}`, targets: [written] };
  }
  if (cmd === "sed") {
    if (args.includes("-i") || args.some((a) => a.startsWith("-i"))) {
      const files = positional(args).slice(1);
      return { kind: "edit", title: `sed -i ${files.join(", ")}`, targets: files };
    }
    const pos = positional(args, new Set(["-e", "-f"]));
    const script = pos[0] ?? "";
    const files = pos.slice(1);
    const range = /^(\d+)(?:,(\d+|\$))?p$/.exec(script);
    const file = files.join(", ") || "stdin";
    return {
      kind: "read",
      title: range ? `read ${file}:${range[1]}-${range[2] ?? range[1]}` : `read ${file}`,
      targets: files,
    };
  }
  if (READERS.has(cmd)) {
    const files = positional(args);
    if (cmd === "jq")
      return {
        kind: "read",
        title: `read ${files.slice(1).join(", ") || "json"}`,
        targets: files.slice(1),
      };
    return { kind: "read", title: files.length ? `read ${files.join(", ")}` : cmd, targets: files };
  }
  if (SEARCHERS.has(cmd)) {
    if (args.includes("--files")) {
      const dirs = positional(args);
      return {
        kind: "search",
        title: `list ${dirs.join(", ") || "."}`,
        targets: dirs,
        isSearch: true,
      };
    }
    const eIdx = args.indexOf("-e");
    const pos = positional(args);
    const pattern = eIdx >= 0 ? args[eIdx + 1] : pos.shift();
    return {
      kind: "search",
      title: `search "${short(pattern ?? "", 50)}"${pos.length ? ` in ${pos.join(", ")}` : ""}`,
      targets: pos,
      isSearch: true,
    };
  }
  if (LISTERS.has(cmd)) {
    const dirs = positional(args).filter((a) => !a.startsWith("("));
    return {
      kind: "search",
      title: `list ${dirs.join(", ") || "."}`,
      targets: dirs,
      // No isSearch: for ls/find, exit 1 is a real failure, not "no match".
    };
  }
  if (cmd === "git") {
    let j = 0;
    while (j < args.length && args[j]!.startsWith("-"))
      j += args[j] === "-C" || args[j] === "-c" ? 2 : 1;
    const sub = args[j] ?? "";
    const rest = args.slice(j + 1);
    const title = short(`git ${sub} ${rest.join(" ")}`.trim(), 90);
    const readOnly =
      GIT_READ.has(sub) ||
      (sub === "branch" && rest.every((a) => a.startsWith("-") && !/^-[dDmM]/.test(a))) ||
      (sub === "stash" && rest[0] === "list") ||
      (sub === "worktree" && rest[0] === "list");
    return { kind: readOnly ? "read" : "git", title };
  }
  if (cmd === "gh") {
    const [area = "", action = ""] = positional(args);
    const title = short(`gh ${args.join(" ")}`, 90);
    const isWrite =
      GH_WRITE.test(action) ||
      (area === "api" &&
        args.some(
          (a) =>
            /^(-X|--method)$/.test(a) || /^-[fF]$/.test(a) || /^--(field|raw-field|input)$/.test(a),
        ));
    return { kind: isWrite ? "git" : "read", title };
  }
  if (cmd === "curl" || cmd === "wget" || cmd === "http") {
    const url = positional(args).find((a) => /^https?:/.test(a)) ?? "";
    return { kind: "web", title: `${cmd} ${short(url, 70)}` };
  }
  if (
    cmd === "rm" ||
    cmd === "mv" ||
    cmd === "cp" ||
    cmd === "mkdir" ||
    cmd === "touch" ||
    cmd === "chmod" ||
    cmd === "ln"
  ) {
    const files = positional(args);
    return { kind: "edit", title: `${cmd} ${short(files.join(" "), 80)}`, targets: files };
  }
  const shown = argv
    .map((a) => (a.includes(" ") ? JSON.stringify(a) : a))
    .join(" ")
    .replace(/(?:\.\/)?node_modules\/\.bin\//g, "");
  return { kind: classifyRun(argv), title: short(shown, 100) };
}

type RunKind = "docker" | "setup" | "build" | "test" | "run";

const DOCKER = new Set(["docker", "docker-compose", "podman", "kubectl", "helm", "colima"]);
const TEST_TOOLS = new Set([
  "pytest",
  "jest",
  "vitest",
  "mocha",
  "rspec",
  "phpunit",
  "ctest",
  "playwright",
  "cypress",
  "ava",
  "nextest",
]);
const BUILD_TOOLS = new Set([
  "tsc",
  "tsgo",
  "eslint",
  "oxlint",
  "biome",
  "prettier",
  "ruff",
  "mypy",
  "pyright",
  "esbuild",
  "webpack",
  "rollup",
  "swc",
  "gcc",
  "clang",
  "javac",
  "rustc",
  "swiftc",
  "xcodebuild",
  "cmake",
  "ninja",
]);
/** Package managers and task runners: the intent is in their subcommand or script name. */
const RUNNERS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "vp",
  "vpr",
  "npx",
  "pnpx",
  "bunx",
  "deno",
  "go",
  "cargo",
  "make",
  "just",
  "uv",
  "poetry",
  "pip",
  "pip3",
  "pipx",
  "brew",
  "apt",
  "apt-get",
  "gradle",
  "mvn",
  "dotnet",
  "swift",
  "mix",
  "bundle",
  "rake",
  "composer",
]);
/** Runner flags whose next word is a value, e.g. `pnpm --filter t3 test`. */
const RUNNER_VALUE_FLAGS = new Set([
  "--filter",
  "-F",
  "-C",
  "--dir",
  "--prefix",
  "--workspace",
  "-w",
  "-p",
  "--package",
  "--manifest-path",
  "--cwd",
  "--project",
  "-f",
  "--file",
]);
const PASS_THROUGH = new Set(["run", "exec", "x", "dlx"]);

/** Classifies a script or subcommand name: `test:unit` → test, `typecheck` → build, `install` → setup. */
function classifyWord(word: string): RunKind {
  const w = word.toLowerCase().replace(/^.*\//, "");
  if (/(^|[^a-z])(test|tests|spec|e2e)([^a-z]|$)/.test(w) || /^(t|unittest|nextest)$/.test(w))
    return "test";
  if (
    /^(i|install|add|ci|fetch|download|sync|tidy|get|restore|update|upgrade|link|bootstrap|setup|prepare|mod)$/.test(
      w,
    )
  )
    return "setup";
  if (
    /^(build|compile|typecheck|tc|check|lint|vet|clippy|fmt|format|bundle|pack|dist|generate|codegen)([:.-]|$)/.test(
      w,
    )
  )
    return "build";
  return "run";
}

/** What a non-builtin command does, independent of its toolchain (`go test` and `vp test` are both test). */
export function classifyRun(argv: ReadonlyArray<string>): RunKind {
  const exe = (argv[0] ?? "").replace(/^.*\//, "");
  const args = argv.slice(1);
  if (DOCKER.has(exe)) return "docker";
  if (TEST_TOOLS.has(exe)) return "test";
  if (BUILD_TOOLS.has(exe)) return "build";
  // `python -m pytest`, `node --test`
  const m = args.indexOf("-m");
  if (/^(python[\d.]*|node|deno)$/.test(exe)) {
    if (m >= 0 && args[m + 1]) return classifyRun(args.slice(m + 1));
    if (args.includes("--test")) return "test";
    return "run";
  }
  if (!RUNNERS.has(exe)) return classifyWord(exe) === "test" ? "test" : "run";
  // `bun -e <code>`: the code is not a script name (and may contain `=`).
  if (args.some((x) => /^(-e|--eval|-p|--print)$/.test(x))) return "run";
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("-")) {
      if (RUNNER_VALUE_FLAGS.has(a)) i++;
      continue;
    }
    if (a.includes("=")) continue; // make VAR=value
    positional.push(a);
  }
  const [task, ...rest] = positional;
  if (!task) return exe === "make" ? "build" : exe === "yarn" || exe === "bun" ? "setup" : "run";
  // `npx vitest`, `uv pip install`: the next word is the real command.
  if (exe === "npx" || exe === "pnpx" || exe === "bunx" || RUNNERS.has(task)) {
    return classifyRun([task, ...rest]);
  }
  if (PASS_THROUGH.has(task) && rest[0]) {
    const inner = classifyRun(rest);
    return inner === "run" ? classifyWord(rest[0]) : inner;
  }
  return classifyWord(task);
}

/** Humanizes a (possibly wrapped, chained, piped) shell command into parts. */
export function humanizeCommand(raw: string): Part[] {
  const parts: Part[] = [];
  for (const stages of splitCommand(unwrapShell(raw.trim()))) {
    const first = stages[0] ? humanizeStage(stages[0]) : null;
    // Later pipeline stages only matter when they write files (tee / redirect).
    const writer = stages
      .slice(1)
      .map(humanizeStage)
      .find((p) => p?.kind === "edit");
    const part = writer ?? first;
    if (part) parts.push(part);
  }
  return parts;
}
