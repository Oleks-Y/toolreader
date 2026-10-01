import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import type { Action, ActionKind, Entry, FileChange, Message } from "./domain.ts";
import {
  ClaudeContent,
  ClaudeResult,
  CursorRawOutput,
  type CodexItem,
  type ToolPayload,
} from "./payload.ts";
import { humanizeCommand, strongestKind } from "./shell.ts";

export type ActivityRow = {
  readonly id: string;
  readonly at: string;
  readonly kind: string;
  readonly tone: string;
  readonly summary: string;
  readonly payload: ToolPayload;
  /** Source order. When set on both rows it breaks timestamp ties (Codex); T3 rows leave it unset. */
  readonly seq?: number;
};
export type MessageRow = {
  readonly id: string;
  readonly at: string;
  readonly role: string;
  readonly text: string;
  readonly seq?: number;
};

const TOOL_LIFECYCLE = new Set(["tool.started", "tool.updated", "tool.completed"]);
const EVENT_KINDS = new Set([
  "runtime.error",
  "tool.denied",
  "provider.turn.start.failed",
  "context-compaction",
]);
const MESSAGE_ROLES = new Set<string>(["user", "assistant", "reasoning"]);
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

const decodeClaudeResult = Schema.decodeUnknownOption(ClaudeResult);
const decodeClaudeContent = Schema.decodeUnknownOption(ClaudeContent);
const decodeCursorRawOutput = Schema.decodeUnknownOption(CursorRawOutput);

const str = (v: unknown): string | undefined => (Predicate.isString(v) && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined => (Predicate.isNumber(v) ? v : undefined);
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const json = (v: unknown) => (v === undefined || v === null ? undefined : JSON.stringify(v));

export function headTail(s: string | undefined, head = 1500, tail = 1500): string | undefined {
  if (!s) return undefined;
  if (s.length <= head + tail + 40) return s;
  return `${s.slice(0, head)}\n… ${s.length - head - tail} chars omitted …\n${s.slice(-tail)}`;
}

/** Flattens Claude tool_result content (string or `[{ type: "text", text }]`). */
function resultText(result: unknown): string | undefined {
  const content = decodeClaudeResult(result).pipe(
    Option.flatMap((r) => decodeClaudeContent(r.content)),
  );
  if (Option.isNone(content)) return undefined;
  const c = content.value;
  return Predicate.isString(c) ? c : c.map((x) => x.text ?? "").join("\n") || undefined;
}

const isClaudeError = (result: unknown) =>
  Option.exists(decodeClaudeResult(result), (r) => r.is_error === true);

/** Minimal hunk between two texts: trims the common prefix/suffix lines. */
export function textDiff(
  oldText: string,
  newText: string,
): { diff: string; added: number; removed: number } {
  const a = oldText ? oldText.split("\n") : [];
  const b = newText ? newText.split("\n") : [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const removed = a.slice(start, endA);
  const added = b.slice(start, endB);
  // Standard unified header; an empty side starts at 0, as `diff -u` writes it.
  const oldStart = removed.length ? start + 1 : start;
  const newStart = added.length ? start + 1 : start;
  const diff = [
    `@@ -${oldStart},${removed.length} +${newStart},${added.length} @@`,
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ].join("\n");
  return { diff, added: added.length, removed: removed.length };
}

/**
 * apply_patch hunks start with a bare `@@` (or `@@ context`) and carry no line numbers. Gives them
 * consecutive made-up ones so the diff parses; the caller hides line numbers.
 */
function numberHunks(diff: string): string {
  let oldLine = 1;
  let newLine = 1;
  return diff
    .split(/\n(?=@@)/)
    .map((hunk) => {
      const [header = "", ...lines] = hunk.split("\n");
      const body = lines.filter((l) => l !== "*** End of File");
      // Models leave blank lines in patches: trailing ones are noise, inner ones are blank context.
      while (body.at(-1) === "") body.pop();
      for (let i = 0; i < body.length; i++) if (body[i] === "") body[i] = " ";
      const oldCount = body.filter((l) => !l.startsWith("+")).length;
      const newCount = body.filter((l) => !l.startsWith("-")).length;
      const context = header.replace(/^@@\s?/, "");
      const out = [
        `@@ -${oldLine},${oldCount} +${newLine},${newCount} @@${context ? ` ${context}` : ""}`,
        ...body,
      ];
      oldLine += oldCount;
      newLine += newCount;
      return out.join("\n");
    })
    .join("\n");
}

/** Codex sends whole-file content for added/deleted files; turn it into one hunk. */
function asHunk(content: string, side: "+" | "-"): string {
  if (!content) return "";
  const lines = content.replace(/\n$/, "").split("\n");
  const header = side === "+" ? `@@ -0,0 +1,${lines.length} @@` : `@@ -1,${lines.length} +0,0 @@`;
  return [header, ...lines.map((l) => `${side}${l}`)].join("\n");
}

const MAX_DIFF_CHARS = 12_000;

/** Cuts one hunk to its first lines that fit, rewriting the header counts so it still parses. */
function cutHunk(hunk: string, maxChars: number): string {
  const [header = "", ...lines] = hunk.split("\n");
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(header);
  if (!m) return hunk.slice(0, maxChars);
  const kept: string[] = [];
  let size = header.length;
  for (const line of lines) {
    if (kept.length && size + line.length + 1 > maxChars) break;
    kept.push(line);
    size += line.length + 1;
  }
  const oldCount = kept.filter((l) => !l.startsWith("+")).length;
  const newCount = kept.filter((l) => !l.startsWith("-")).length;
  return [`@@ -${m[1]},${oldCount} +${m[2]},${newCount} @@${m[3]}`, ...kept].join("\n");
}

/** Keeps whole hunks up to the size limit (cutting an oversized first one), so the result still parses. */
export function clipDiff(diff: string): { diff: string; truncated?: boolean } {
  if (diff.length <= MAX_DIFF_CHARS) return { diff };
  const hunks = diff.split(/\n(?=@@ )/);
  const kept: string[] = [];
  let size = 0;
  for (const hunk of hunks) {
    if (size + hunk.length > MAX_DIFF_CHARS) {
      if (!kept.length) kept.push(cutHunk(hunk, MAX_DIFF_CHARS));
      break;
    }
    kept.push(hunk);
    size += hunk.length + 1;
  }
  return { diff: kept.join("\n"), truncated: true };
}

function unifiedDiffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}

function fileChanges(p: ToolPayload): FileChange[] {
  const d = p.data;
  // Codex: item.changes[{ path, diff, kind: { type: add | update | delete } }]
  if (d?.item?.changes) {
    return d.item.changes.map((c): FileChange => {
      const type = c.kind?.type;
      const raw = c.diff ?? "";
      const isNew = type === "add";
      const isDeleted = type === "delete";
      const numbered = /^@@ -\d/m.test(raw);
      const bare = !numbered && type === "update" && /^@@/m.test(raw);
      const diff = numbered ? raw : bare ? numberHunks(raw) : asHunk(raw, isDeleted ? "-" : "+");
      return {
        path: c.path ?? "?",
        ...unifiedDiffStats(diff),
        isNew,
        isDeleted,
        ...clipDiff(diff),
        exactLines: !bare,
      };
    });
  }
  // Cursor: content[{ type: "diff", path, oldText, newText }]
  if (d?.content) {
    return d.content.flatMap((c): FileChange[] => {
      if (!c.path) return [];
      const t = textDiff(c.oldText ?? "", c.newText ?? "");
      return [
        {
          path: c.path,
          added: t.added,
          removed: t.removed,
          isNew: c.oldText == null,
          isDeleted: d.kind === "delete",
          ...clipDiff(t.diff),
        },
      ];
    });
  }
  // Claude: Edit / MultiEdit / Write / NotebookEdit
  const input = d?.input ?? {};
  const path = str(input.file_path) ?? str(input.notebook_path);
  if (!path) return [];
  const created = /created/i.test(resultText(d?.result) ?? "");
  const edits: Array<readonly [string, string]> =
    d?.toolName === "Write"
      ? [["", String(input.content ?? "")]]
      : Array.isArray(input.edits)
        ? input.edits.map((e: unknown) =>
            Predicate.isObject(e)
              ? ([String(e["old_string"] ?? ""), String(e["new_string"] ?? "")] as const)
              : (["", ""] as const),
          )
        : [[String(input.old_string ?? ""), String(input.new_string ?? input.new_source ?? "")]];
  let added = 0;
  let removed = 0;
  const diffs: string[] = [];
  for (const [o, n] of edits) {
    const t = textDiff(o, n);
    added += t.added;
    removed += t.removed;
    diffs.push(t.diff);
  }
  return [
    {
      path,
      added,
      removed,
      isNew: created,
      isDeleted: false,
      ...clipDiff(diffs.join("\n")),
    },
  ];
}

type Draft = Omit<Action, "type" | "id" | "at" | "status"> & { readonly failed?: boolean };

function commandAction(p: ToolPayload): Draft {
  const d = p.data;
  const item: CodexItem = d?.item ?? {};
  const input = d?.input ?? {};
  const raw = Option.getOrUndefined(decodeCursorRawOutput(d?.rawOutput));
  const detail = str(p.detail)?.replace(/^Bash: /, "");
  const command =
    str(item.command) ??
    str(input.command) ??
    str(d?.command) ??
    str(d?.rawInput?.command) ??
    detail ??
    "";
  const claudeOut = resultText(d?.result);
  const claudeError = isClaudeError(d?.result);
  const parsedExit = /^Exit code (\d+)/.exec(claudeOut ?? "")?.[1];
  const exitCode =
    num(item.exitCode) ??
    num(raw?.exitCode) ??
    (parsedExit ? Number(parsedExit) : claudeError ? 1 : undefined);
  const output =
    str(item.aggregatedOutput) ??
    claudeOut ??
    ([str(raw?.stdout), str(raw?.stderr)].filter(Boolean).join("\n") || undefined);

  const parts = humanizeCommand(command);
  let kind: ActionKind = parts.length ? strongestKind(parts.map((x) => x.kind)) : "run";
  const actions = item.commandActions ?? [];
  if (
    kind === "run" &&
    actions.length &&
    actions.every((a) => ["read", "search", "listFiles"].includes(a.type ?? ""))
  ) {
    kind = actions.some((a) => a.type !== "read") ? "search" : "read";
  }
  const allSearch = parts.length > 0 && parts.every((x) => x.isSearch);
  const noMatch = allSearch && exitCode === 1;
  return {
    kind,
    title: parts.map((x) => x.title).join(" · ") || short(command, 120),
    hint: str(input.description),
    command,
    exitCode,
    output: headTail(output),
    parts: parts.length > 1 ? parts.map(({ kind, title }) => ({ kind, title })) : undefined,
    targets: parts.flatMap((x) => x.targets ?? []),
    noMatch: noMatch || undefined,
    failed: !noMatch && ((exitCode !== undefined && exitCode !== 0) || claudeError),
  };
}

function editAction(p: ToolPayload): Draft {
  const files = fileChanges(p);
  const names = files.map((f) => f.path.replace(/^.*\//, ""));
  return {
    kind: "edit",
    title:
      files.length === 1 ? files[0]!.path : `${files.length} files: ${short(names.join(", "), 90)}`,
    files,
    targets: files.map((f) => f.path),
    output: headTail(resultText(p.data?.result) ?? resultText(p.data?.item?.result), 400, 200),
    failed: isClaudeError(p.data?.result),
  };
}

function otherToolAction(p: ToolPayload): Draft {
  const d = p.data;
  const item: CodexItem = d?.item ?? {};
  const input = d?.input ?? {};
  const toolName = str(d?.toolName);
  const raw = Option.getOrUndefined(decodeCursorRawOutput(d?.rawOutput));
  // Codex MCP results are `{ content: [{ text }] }` like Claude's; recovered rollout calls carry text.
  const out = headTail(
    resultText(d?.result) ??
      resultText(item.result) ??
      str(item.result) ??
      json(item.result) ??
      json(d?.rawOutput),
    800,
    400,
  );
  const failed = isClaudeError(d?.result) || Boolean(item.error) || Boolean(raw?.error);
  const args = (o: unknown) =>
    short((str(o) ?? json(o) ?? "").replace(/^\{\}$/, "").replace(/\s+/g, " "), 100);
  const s = (v: unknown) => str(v) ?? "";

  // Claude built-in tools
  if (toolName === "Read") {
    const offset = num(input.offset);
    const range = offset ? `:${offset}-${offset + (num(input.limit) ?? 0)}` : "";
    return {
      kind: "read",
      title: `read ${s(input.file_path)}${range}`,
      targets: [s(input.file_path)],
      failed,
    };
  }
  if (toolName === "Grep") {
    const path = str(input.path);
    return {
      kind: "search",
      title: `search "${short(s(input.pattern), 50)}"${path ? ` in ${path}` : ""}`,
      targets: path ? [path] : [],
      output: out,
      failed,
    };
  }
  if (toolName === "Glob") {
    const path = str(input.path);
    return {
      kind: "search",
      title: `list ${s(input.pattern)}${path ? ` in ${path}` : ""}`,
      output: out,
      failed,
    };
  }
  if (toolName === "WebFetch")
    return {
      kind: "web",
      title: `fetch ${s(input.url)}`,
      hint: str(input.prompt),
      output: out,
      failed,
    };
  if (toolName === "WebSearch")
    return { kind: "web", title: `web search "${s(input.query)}"`, output: out, failed };
  if (toolName === "Agent" || toolName === "Task") {
    const type = str(input.subagent_type);
    return {
      kind: "agent",
      title: `subagent${type ? ` (${type})` : ""}: ${s(input.description)}`,
      hint: short(s(input.prompt), 400) || undefined,
      output: out,
      failed,
    };
  }
  if (toolName === "AskUserQuestion") {
    const first =
      Array.isArray(input.questions) && Predicate.isObject(input.questions[0])
        ? s(input.questions[0]["question"])
        : "";
    return { kind: "tool", title: `asked user: ${short(first, 90)}`, output: out, failed };
  }
  if (toolName === "Skill") {
    const extra = str(input.args);
    return {
      kind: "tool",
      title: `skill ${s(input.skill)}${extra ? ` ${short(extra, 60)}` : ""}`,
      failed,
    };
  }
  if (toolName?.startsWith("mcp__")) {
    const [, server = "", tool = ""] = toolName.split("__");
    return {
      kind: "tool",
      title: `${server} · ${tool} ${args(input)}`.trim(),
      output: out,
      failed,
    };
  }
  if (toolName)
    return { kind: "tool", title: `${toolName} ${args(input)}`.trim(), output: out, failed };

  // Codex items
  if (item.type === "mcpToolCall")
    return {
      kind: "tool",
      title: `${s(item.server)} · ${s(item.tool)} ${args(item.arguments)}`.trim(),
      output: out,
      failed,
    };
  if (item.type === "webSearch") {
    const a = item.action;
    return {
      kind: "web",
      title:
        a?.type === "openPage" || a?.type === "findInPage"
          ? `fetch ${s(a.url)}`
          : `web search "${short(s(item.query ?? a?.query), 80)}"`,
      failed,
    };
  }
  if (item.type === "dynamicToolCall")
    return {
      kind: "tool",
      title: `${s(item.tool)} ${args(item.arguments)}`.trim(),
      output: out,
      failed,
    };
  if (item.type === "imageGeneration") {
    const prompt = str(item.revisedPrompt);
    return {
      kind: "tool",
      title: `generate image${prompt ? `: ${short(prompt.split("\n")[0]!, 90)}` : ""}`,
      hint: prompt,
      failed,
    };
  }
  if (item.type === "imageView")
    return {
      kind: "read",
      title: `view image ${s(item.path)}`,
      targets: item.path ? [item.path] : [],
      failed,
    };
  if (item.type === "collabAgentToolCall") {
    const prompt = str(item.prompt);
    return {
      kind: "agent",
      title: `subagent ${s(item.tool)}${prompt ? `: ${short(prompt, 90)}` : ""}`,
      hint: prompt,
      failed: item.status === "failed",
    };
  }

  // Cursor (ACP kinds). Cursor doesn't record paths for reads.
  const kindMap: Record<string, ActionKind> = {
    read: "read",
    search: "search",
    fetch: "web",
    execute: "run",
    edit: "edit",
    delete: "edit",
  };
  const label = str(p.title) ?? str(p.detail) ?? (p.itemType ?? "").replace(/_/g, " ");
  return { kind: kindMap[d?.kind ?? ""] ?? "tool", title: label, output: out, failed };
}

function toAction(id: string, at: string, p: ToolPayload, summary: string): Action {
  const claudeTool = p.data?.toolName;
  const draft =
    p.itemType === "command_execution"
      ? commandAction(p)
      : p.itemType === "file_change" && (!claudeTool || FILE_TOOLS.has(claudeTool))
        ? editAction(p)
        : otherToolAction(p);
  const { failed, ...rest } = draft;
  const title =
    rest.title || str(p.title) || str(summary) || (p.itemType ?? "tool").replace(/_/g, " ");
  // Codex marks `rg` exit 1 as failed; a search that found nothing is not a failure.
  const status =
    ((p.status === "failed" || p.status === "declined") && !rest.noMatch) || failed
      ? "failed"
      : p.status === "inProgress"
        ? "running"
        : p.status === "unknown"
          ? "unknown"
          : "ok";
  return { type: "action", id, at, status, ...rest, title };
}

/** Turns T3 activity + message rows into a time-ordered entry list. Rows must be in insertion order. */
export function normalize(
  activities: ReadonlyArray<ActivityRow>,
  messages: ReadonlyArray<MessageRow>,
  opts: { root?: string | null; home?: string } = {},
): Entry[] {
  const tidy = (s: string) => {
    let out = s;
    if (opts.root) out = out.split(`${opts.root}/`).join("");
    if (opts.home) out = out.split(opts.home).join("~");
    return out;
  };

  const entries: Entry[] = [];
  const seqOf = new Map<Entry, number>();
  const push = (entry: Entry, seq: number | undefined) => {
    entries.push(entry);
    if (seq !== undefined) seqOf.set(entry, seq);
  };
  // Without `seq`, messages go first so they win timestamp ties (the sort below is stable).
  for (const m of messages) {
    if (!m.text.trim() || !MESSAGE_ROLES.has(m.role)) continue;
    push(
      {
        type: "message",
        id: m.id,
        at: m.at,
        role: m.role as Message["role"],
        text: m.text,
      },
      m.seq,
    );
  }

  // A tool call emits started/updated/completed rows; keep the first time and the last payload.
  const calls = new Map<
    string,
    { at: string; payload: ToolPayload; summary: string; seq: number | undefined }
  >();
  // Older Codex rows have no toolCallId: pair started → completed by their detail text instead.
  const openByDetail = new Map<string, string>();
  for (const row of activities) {
    if (TOOL_LIFECYCLE.has(row.kind)) {
      let key = row.payload.toolCallId ?? row.payload.data?.toolCallId;
      if (!key) {
        const detailKey = `${row.payload.itemType}:${row.payload.detail ?? row.summary}`;
        key = openByDetail.get(detailKey) ?? row.id;
        if (row.kind === "tool.completed") openByDetail.delete(detailKey);
        else openByDetail.set(detailKey, key);
      }
      const prev = calls.get(key);
      calls.set(key, {
        at: prev?.at ?? row.at,
        payload: row.kind === "tool.started" && prev ? prev.payload : row.payload,
        summary: row.summary,
        seq: prev ? prev.seq : row.seq,
      });
    } else if (EVENT_KINDS.has(row.kind)) {
      const detail = str(row.payload.detail) ?? str(row.payload.message) ?? "";
      push(
        {
          type: "event",
          id: row.id,
          at: row.at,
          tone: row.tone === "error" ? "error" : "info",
          text: short(`${row.summary}${detail ? `: ${detail}` : ""}`, 400),
        },
        row.seq,
      );
    }
  }
  for (const [id, { at, payload, summary, seq }] of calls) {
    const a = toAction(id, at, payload, summary);
    push(
      {
        ...a,
        title: tidy(a.title),
        parts: a.parts?.map((p) => ({ ...p, title: tidy(p.title) })),
        targets: a.targets?.map(tidy),
        files: a.files?.map((f) => ({ ...f, path: tidy(f.path) })),
      },
      seq,
    );
  }
  return entries.sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? -1 : 1;
    const sa = seqOf.get(a);
    const sb = seqOf.get(b);
    return sa !== undefined && sb !== undefined ? sa - sb : 0;
  });
}
