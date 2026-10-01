// Tool calls recovered from Codex rollout files. `thread/read` rebuilds items only from persisted
// `item_completed` events, and most rollouts persist those for messages alone: commands, patches,
// MCP and web calls survive only as `response_item` lines. `rolloutItems` turns them into
// app-server item shapes, so codex.ts handles them exactly like thread/read items.
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

const opt = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema));

const Payload = Schema.Struct({
  type: opt(Schema.String),
  id: opt(Schema.String),
  call_id: opt(Schema.String),
  name: opt(Schema.String),
  namespace: opt(Schema.String),
  /** function_call: a JSON string; tool_search_call: an object. */
  arguments: opt(Schema.Unknown),
  /** custom_tool_call (apply_patch, code-mode exec): raw text. */
  input: opt(Schema.String),
  /** A string, or `[{ type: "input_text", text }]`. */
  output: opt(Schema.Unknown),
  action: opt(Schema.Unknown),
  status: opt(Schema.String),
  turn_id: opt(Schema.String),
});
const Line = Schema.Struct({ timestamp: Schema.String, payload: Payload });
const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Line));

const Args = Schema.Record(Schema.String, Schema.Unknown);
const decodeArgs = Schema.decodeUnknownOption(Schema.fromJsonString(Args));
const OutputText = Schema.Union([
  Schema.String,
  Schema.Array(Schema.Struct({ type: opt(Schema.String), text: opt(Schema.String) })),
]);
const decodeOutput = Schema.decodeUnknownOption(OutputText);
/** Older shell and apply_patch outputs: `{"output": "...", "metadata": {"exit_code": 0}}`. */
const JsonOutput = Schema.Struct({
  output: opt(Schema.String),
  metadata: opt(Schema.Struct({ exit_code: opt(Schema.Number) })),
});
const decodeJsonOutput = Schema.decodeUnknownOption(Schema.fromJsonString(JsonOutput));
/** What a script prints when it passes on the whole `tools.exec_command` result (or one per command). */
const ExecResult = Schema.Struct({ exit_code: Schema.Number, output: opt(Schema.String) });
const decodeExecResults = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Union([ExecResult, Schema.Array(ExecResult)])),
);
const decodeJsonStringLiteral = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String));
const WebAction = Schema.Struct({
  type: opt(Schema.String),
  query: opt(Schema.String),
  queries: opt(Schema.Array(Schema.String)),
  url: opt(Schema.String),
  pattern: opt(Schema.String),
});
const decodeWebAction = Schema.decodeUnknownOption(WebAction);

export type RolloutCall = {
  readonly id: string;
  readonly at: string;
  /** Line index in the rollout: orders calls against thread/read items. */
  readonly line: number;
  readonly turnId: string | undefined;
  readonly name: string;
  readonly namespace: string | undefined;
  /** Parsed arguments, raw custom-tool input, or the web search action. */
  readonly args: unknown;
  /** One per output line; `write_stdin` and code-mode `wait` add theirs to the call they continue. */
  readonly outputs: string[];
  lastLine: number;
  /** Got a final result. Output that names a session or cell still running does not count. */
  finished: boolean;
  /** Its turn completed or aborted: not finished by then means it was cut off. */
  ended: boolean;
};

export type RolloutScan = {
  /** Item id → timestamp of the first line that mentions it. */
  readonly times: Map<string, string>;
  /** Item id → index of the first line that mentions it. */
  readonly lines: Map<string, number>;
  readonly calls: RolloutCall[];
  /** Turn ids seen in `task_started`. */
  readonly turns: Set<string>;
  readonly byId: Map<string, RolloutCall>;
  /** `session:<id>` / `cell:<id>` → the call still running there. */
  readonly running: Map<string, RolloutCall>;
  open: RolloutCall[];
  turnId: string | undefined;
  line: number;
};

export const emptyScan = (): RolloutScan => ({
  times: new Map(),
  lines: new Map(),
  calls: [],
  turns: new Set(),
  byId: new Map(),
  running: new Map(),
  open: [],
  turnId: undefined,
  line: 0,
});

const SCANNED = new Set([
  "function_call",
  "custom_tool_call",
  "function_call_output",
  "custom_tool_call_output",
  "web_search_call",
  "local_shell_call",
  "task_started",
  "task_complete",
  "turn_aborted",
]);
const PAYLOAD_TYPE = '"payload":{"type":"';

const outputText = (output: unknown): string =>
  Option.match(decodeOutput(output), {
    onNone: () => "",
    onSome: (o) => {
      if (Predicate.isString(o)) return o;
      const texts = o.map((p) => p.text ?? (p.type === "input_image" ? "[image]" : ""));
      // Parts are often a header ending in a newline, then the content.
      return texts.map((t, i) => (i && !texts[i - 1]!.endsWith("\n") ? `\n${t}` : t)).join("");
    },
  });

/** Folds rollout lines into a scan; feed a whole file, or one line at a time while streaming. */
export function scanRollout(lines: Iterable<string>, scan = emptyScan()): RolloutScan {
  for (const line of lines) {
    const index = scan.line++;
    if (!line.startsWith('{"timestamp":"')) continue;
    const at = line.slice(14, line.indexOf('"', 14));
    for (const m of line.matchAll(/"(?:id|call_id|item_id)":"([^"]+)"/g)) {
      if (scan.times.has(m[1]!)) continue;
      scan.times.set(m[1]!, at);
      scan.lines.set(m[1]!, index);
    }
    const p = line.indexOf(PAYLOAD_TYPE);
    if (p < 0 || p > 200) continue;
    const start = p + PAYLOAD_TYPE.length;
    if (!SCANNED.has(line.slice(start, line.indexOf('"', start)))) continue;
    const decoded = decodeLine(line);
    if (Option.isSome(decoded))
      addLine(scan, index, decoded.value.timestamp, decoded.value.payload);
  }
  return scan;
}

function addLine(scan: RolloutScan, index: number, at: string, p: typeof Payload.Type) {
  switch (p.type) {
    case "task_started":
      scan.turnId = p.turn_id ?? undefined;
      if (p.turn_id) scan.turns.add(p.turn_id);
      return;
    case "task_complete":
    case "turn_aborted":
      for (const c of scan.open) c.ended = true;
      scan.open = [];
      return;
    case "function_call_output":
    case "custom_tool_call_output": {
      const call = p.call_id ? scan.byId.get(p.call_id) : undefined;
      if (!call) return;
      const text = outputText(p.output);
      call.outputs.push(text);
      call.lastLine = index;
      const session = /^Process running with session ID (\S+)/m.exec(text)?.[1];
      const cell = /^Script running with cell ID (\S+)/m.exec(text)?.[1];
      if (session) scan.running.set(`session:${session}`, call);
      else if (cell) scan.running.set(`cell:${cell}`, call);
      call.finished = !session && !cell;
      return;
    }
  }
  const id = p.call_id ?? p.id ?? `rollout-line-${index}`;
  const args =
    p.type === "web_search_call"
      ? p.action
      : p.type === "local_shell_call"
        ? { command: Predicate.isObject(p.action) ? p.action["command"] : undefined }
        : Predicate.isString(p.arguments)
          ? Option.getOrElse(decodeArgs(p.arguments), () => ({}))
          : (p.input ?? p.arguments);
  const name =
    p.type === "web_search_call" ? "web_search" : p.type === "local_shell_call" ? "shell" : p.name;
  if (!name) return;

  // `write_stdin` and code-mode `wait` continue a command or script that is still running.
  const record = Predicate.isObject(args) ? (args as Record<string, unknown>) : {};
  const continues =
    name === "write_stdin" && record["session_id"] != null
      ? scan.running.get(`session:${String(record["session_id"])}`)
      : name === "wait" && record["cell_id"] != null
        ? scan.running.get(`cell:${String(record["cell_id"])}`)
        : undefined;
  if (continues) {
    // Its output lands on the call it continues.
    scan.byId.set(id, continues);
    return;
  }
  if (name === "write_stdin" || (name === "wait" && record["cell_id"] != null)) return;

  const call: RolloutCall = {
    id,
    at,
    line: index,
    turnId: scan.turnId,
    name,
    namespace: p.namespace ?? undefined,
    args,
    outputs: p.type === "web_search_call" ? [p.status === "failed" ? "failed" : ""] : [],
    lastLine: index,
    finished: p.type === "web_search_call",
    ended: false,
  };
  scan.calls.push(call);
  scan.byId.set(id, call);
  scan.open.push(call);
}

// --- Output parsing ---

/** `Output:` starts the tool's own output in exec_command, shell_command, MCP and script results. */
const body = (text: string) => {
  const i = text.indexOf("\nOutput:\n");
  return i < 0 ? text : text.slice(i + "\nOutput:\n".length);
};

type CommandResult = { exitCode: number | undefined; output: string; failed: boolean };

/** Exit code and output across exec_command / shell / shell_command / apply_patch output formats. */
function commandResult(outputs: ReadonlyArray<string>): CommandResult {
  let exitCode: number | undefined;
  let failed = false;
  const parts: string[] = [];
  for (const text of outputs) {
    const json = text.startsWith("{") ? Option.getOrUndefined(decodeJsonOutput(text)) : undefined;
    if (json) {
      exitCode = json.metadata?.exit_code ?? exitCode;
      parts.push(json.output ?? "");
      continue;
    }
    const code = /^(?:Process exited with code|Exit code:) (-?\d+)$/m.exec(text)?.[1];
    if (code !== undefined) exitCode = Number(code);
    // Sandbox denials, rejected patches and user aborts come back as bare text.
    if (
      /^(failed in sandbox|apply_patch verification failed|aborted by user|execution error)/.test(
        text,
      )
    )
      failed = true;
    parts.push(body(text));
  }
  return { exitCode, output: parts.join(""), failed: failed || (exitCode ?? 0) !== 0 };
}

// Joins argv the way Codex shows it: Rust `shlex::try_join`. Each word is cut into chunks that are
// left bare, single-quoted or double-quoted; `^` always starts a single-quoted chunk (zsh history).
const BARE = /^[\w+\-./:@\]]$/;
const BARE_OK = 1;
const SINGLE_OK = 2;
const DOUBLE_OK = 4;

function quoteWord(word: string): string {
  if (word === "") return "''";
  let out = "";
  let rest = word;
  while (rest) {
    let ok = BARE_OK | SINGLE_OK | DOUBLE_OK;
    let i = 0;
    if (rest[0] === "^") {
      ok = SINGLE_OK;
      i = 1;
    }
    for (; i < rest.length; i++) {
      const c = rest[i]!;
      if (c === "^") break;
      let next = ok;
      if (!BARE.test(c)) next &= ~BARE_OK;
      if (c === "'" || c === "\\") next &= ~SINGLE_OK;
      if (c === "!" || c === "$" || c === "`") next &= ~DOUBLE_OK;
      if (next === 0) break;
      ok = next;
    }
    const chunk = rest.slice(0, i);
    rest = rest.slice(i);
    out +=
      ok & BARE_OK
        ? chunk
        : ok & SINGLE_OK
          ? `'${chunk}'`
          : `"${chunk.replace(/["\\]/g, (c) => `\\${c}`)}"`;
  }
  return out;
}

export const shellJoin = (argv: ReadonlyArray<string>) => argv.map(quoteWord).join(" ");

/** apply_patch text → app-server fileChange changes. Update hunks keep bare `@@` headers. */
export function parsePatch(patch: string) {
  const changes: Array<{ path: string; kind: { type: string }; diff: string }> = [];
  let current: { path: string; kind: { type: string }; lines: string[] } | undefined;
  const flush = () => {
    if (!current) return;
    const lines = current.lines;
    const diff =
      current.kind.type === "add" ? lines.map((l) => l.slice(1)).join("\n") : lines.join("\n");
    changes.push({ path: current.path, kind: current.kind, diff });
    current = undefined;
  };
  for (const line of patch.split("\n")) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      flush();
      current = { path: header[2]!.trim(), kind: { type: header[1]!.toLowerCase() }, lines: [] };
    } else if (line.startsWith("*** Move to: ") && current) {
      current.path = line.slice("*** Move to: ".length).trim();
    } else if (current && !line.startsWith("*** ")) {
      current.lines.push(line);
    }
  }
  flush();
  return changes;
}

// --- Code-mode scripts ---

/** `cmd` string literals of `tools.exec_command({ cmd: "…" })` calls in a script. */
const scriptCommands = (script: string) =>
  [...script.matchAll(/tools\.exec_command\(\s*\{\s*"?cmd"?\s*:\s*("(?:[^"\\]|\\.)*")/g)].flatMap(
    (m) => Option.toArray(decodeJsonStringLiteral(m[1]!)),
  );
const scriptImage = (script: string) =>
  Option.getOrUndefined(
    Option.flatMap(
      Option.fromNullishOr(
        /tools\.view_image\(\s*\{\s*"?path"?\s*:\s*("(?:[^"\\]|\\.)*")/.exec(script)?.[1],
      ),
      decodeJsonStringLiteral,
    ),
  );
const scriptPatch = (script: string) =>
  script.includes("tools.apply_patch(")
    ? Option.getOrUndefined(
        Option.flatMap(
          Option.fromNullishOr(/"\*\*\* Begin Patch(?:[^"\\]|\\.)*"/.exec(script)?.[0]),
          decodeJsonStringLiteral,
        ),
      )
    : undefined;

// --- Calls → items ---

const COLLAB_NAMESPACES = new Set(["collaboration", "multi_agent_v1"]);
const COLLAB_TOOLS = new Set([
  "spawn_agent",
  "wait_agent",
  "send_input",
  "send_message",
  "followup_task",
  "close_agent",
  "resume_agent",
  "interrupt_agent",
  "list_agents",
]);
/** Bookkeeping, not actions (as with thread/read `plan` items). */
const SKIPPED = new Set(["update_plan", "tool_search_call"]);

const str = (v: unknown) => (Predicate.isString(v) && v.trim() ? v : undefined);

/** Splits `mcp__server__tool`, `server__tool` (0.4x) or a `mcp__server` namespace. */
function mcpName(name: string, namespace: string | undefined) {
  if (namespace?.startsWith("mcp__")) {
    // App connectors: `mcp__codex_apps__github` + `_fetch_pr` → github · fetch_pr
    const server = namespace.slice(5).replace(/__$/, "").split("__").at(-1)!;
    return { server, tool: name.replace(/^_/, "") };
  }
  const parts = name.replace(/^mcp__/, "").split("__");
  if (parts.length < 2) return undefined;
  return { server: parts[0]!, tool: parts.slice(1).join("__") };
}

/** A rollout call as an app-server item, or undefined for bookkeeping calls. */
export function rolloutItem(c: RolloutCall, ended = c.ended): Record<string, unknown> | undefined {
  if (SKIPPED.has(c.name)) return undefined;
  const args = Predicate.isObject(c.args) ? (c.args as Record<string, unknown>) : {};
  const status = (failed: boolean) =>
    failed || (!c.finished && ended) ? "failed" : c.finished ? "completed" : "inProgress";
  const base = { id: c.id };

  const command = (text: string) => {
    const r = commandResult(c.outputs);
    return {
      ...base,
      type: "commandExecution",
      command: text,
      exitCode: r.exitCode,
      aggregatedOutput: r.output,
      status: status(r.failed),
    };
  };
  const fileChange = (patch: string) => {
    const r = commandResult(c.outputs);
    return {
      ...base,
      type: "fileChange",
      changes: parsePatch(patch),
      status: status(r.failed),
      // Shown only when the patch failed: why it was rejected.
      ...(r.failed ? { result: { content: r.output } } : {}),
    };
  };

  switch (c.name) {
    case "exec_command":
    case "shell":
    case "shell_command":
    case "container.exec": {
      const raw = args["cmd"] ?? args["command"];
      if (Array.isArray(raw) && raw[0] === "apply_patch" && Predicate.isString(raw[1]))
        return fileChange(raw[1]);
      const text = Array.isArray(raw) ? shellJoin(raw.map(String)) : (str(raw) ?? "");
      return command(text);
    }
    case "apply_patch":
      return fileChange(str(c.args) ?? str(args["input"]) ?? "");
    case "view_image":
      return { ...base, type: "imageView", path: str(args["path"]), status: status(false) };
    case "web_search": {
      const a = Option.getOrUndefined(decodeWebAction(c.args));
      const type =
        a?.type === "open_page" ? "openPage" : a?.type === "find_in_page" ? "findInPage" : "search";
      const query = a?.query ?? a?.queries?.[0] ?? a?.pattern;
      return {
        ...base,
        type: "webSearch",
        query,
        action: { type, url: a?.url, query, pattern: a?.pattern },
        status: status(c.outputs[0] === "failed"),
      };
    }
  }
  if (c.name === "exec" && Predicate.isString(c.args)) {
    const script = c.args;
    const used = [...script.matchAll(/tools\.(\w+)\(/g)].map((m) => m[1]!);
    if (used.length && used.every((t) => SKIPPED.has(t))) return undefined;
    const failed = c.outputs.some((o) => o.startsWith("Script failed"));
    const cmds = scriptCommands(script);
    const result = c.outputs.map(body).join("");
    if (cmds.length) {
      const decoded = Option.getOrUndefined(decodeExecResults(result.trim()));
      const results = decoded === undefined ? [] : Array.isArray(decoded) ? decoded : [decoded];
      if (results.length === cmds.length) {
        const exitCode = results.find((r) => r.exit_code !== 0)?.exit_code ?? 0;
        return {
          ...base,
          type: "commandExecution",
          command: cmds.join("\n"),
          exitCode,
          aggregatedOutput: results.map((r) => r.output ?? "").join("\n"),
          status: status(failed || exitCode !== 0),
        };
      }
      // Most scripts print only `r.output`: the commands' exit codes are lost, so this stays a
      // script, whose own status is all that is known.
      return {
        ...base,
        type: "dynamicToolCall",
        tool: "script:",
        arguments: cmds.join(" ; "),
        result,
        status: status(failed),
      };
    }
    const patch = scriptPatch(script);
    if (patch) return { ...fileChange(patch), status: status(failed) };
    const image = scriptImage(script);
    if (image) return { ...base, type: "imageView", path: image, status: status(failed) };
    return {
      ...base,
      type: "dynamicToolCall",
      tool: "script",
      arguments: script,
      result,
      status: status(failed),
    };
  }
  if (COLLAB_TOOLS.has(c.name) || COLLAB_NAMESPACES.has(c.namespace ?? "")) {
    const message = str(args["message"]);
    // Collaboration v2 encrypts messages between agents.
    const prompt = message && !message.startsWith("gAAAAA") ? message : str(args["task_name"]);
    const out = c.outputs.join("");
    return {
      ...base,
      type: "collabAgentToolCall",
      tool: c.name,
      prompt,
      // Results are JSON; errors (bad agent id, thread limit) come back as plain text.
      status: status(out.trim() !== "" && !out.trimStart().startsWith("{")),
    };
  }
  const mcp = mcpName(c.name, c.namespace);
  if (mcp) {
    return {
      ...base,
      type: "mcpToolCall",
      ...mcp,
      arguments: c.args,
      result: c.outputs.map(body).join(""),
      status: status(false),
    };
  }
  if (c.name === "request_user_input" || c.name === "request_user_input_async") {
    const questions = Array.isArray(args["questions"]) ? args["questions"] : [];
    const first = Predicate.isObject(questions[0]) ? (questions[0] as Record<string, unknown>) : {};
    return {
      ...base,
      type: "dynamicToolCall",
      tool: "asked user:",
      arguments: str(first["question"]) ?? str(first["title"]) ?? "",
      result: c.outputs.join(""),
      status: status(false),
    };
  }
  return {
    ...base,
    type: "dynamicToolCall",
    tool: c.namespace ? `${c.namespace}.${c.name}` : c.name,
    arguments: c.args,
    result: c.outputs.map(body).join(""),
    status: status(false),
  };
}
