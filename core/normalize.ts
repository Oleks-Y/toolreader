import { humanizeCommand, strongestKind } from "./shell.ts";
import type { Action, ActionKind, Entry, FileChange } from "./types.ts";

export type ActivityRow = { id: string; at: string; kind: string; tone: string; summary: string; payload: any };
export type MessageRow = { id: string; at: string; role: string; text: string };

const TOOL_LIFECYCLE = new Set(["tool.started", "tool.updated", "tool.completed"]);
const EVENT_KINDS = new Set(["runtime.error", "tool.denied", "provider.turn.start.failed", "context-compaction"]);

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function headTail(s: string | undefined, head = 1500, tail = 1500): string | undefined {
  if (!s) return undefined;
  if (s.length <= head + tail + 40) return s;
  return `${s.slice(0, head)}\n… ${s.length - head - tail} chars omitted …\n${s.slice(-tail)}`;
}

/** Flattens Claude tool_result content (string or [{type:"text",text}]). */
function resultText(result: any): string | undefined {
  const c = result?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x?.text === "string" ? x.text : "")).join("\n") || undefined;
  return undefined;
}

/** Minimal hunk between two texts: trims the common prefix/suffix lines. */
export function textDiff(oldText: string, newText: string): { diff: string; added: number; removed: number } {
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
  const diff = [`@@ -${start + 1} +${start + 1} @@`, ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join("\n");
  return { diff, added: added.length, removed: removed.length };
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

function fileChanges(p: any): FileChange[] {
  const d = p.data ?? {};
  // Codex: item.changes[{ path, diff, kind: { type: add | update | delete } }]
  if (Array.isArray(d.item?.changes)) {
    return d.item.changes.map((c: any): FileChange => {
      const type = c.kind?.type;
      const diff = String(c.diff ?? "");
      const isNew = type === "add";
      const stats = isNew && !/^[+@]/m.test(diff) ? { added: diff.split("\n").length, removed: 0 } : unifiedDiffStats(diff);
      return { path: String(c.path ?? "?"), ...stats, isNew, isDeleted: type === "delete", diff: headTail(diff, 6000, 2000) };
    });
  }
  // Cursor: content[{ type: "diff", path, oldText, newText }]
  if (Array.isArray(d.content)) {
    return d.content
      .filter((c: any) => c?.path)
      .map((c: any): FileChange => {
        const t = textDiff(c.oldText ?? "", c.newText ?? "");
        return { path: c.path, added: t.added, removed: t.removed, isNew: c.oldText == null, isDeleted: d.kind === "delete", diff: headTail(t.diff, 6000, 2000) };
      });
  }
  // Claude: Edit / MultiEdit / Write / NotebookEdit
  const input = d.input ?? {};
  const path = str(input.file_path) ?? str(input.notebook_path);
  if (!path) return [];
  const created = /created/i.test(resultText(d.result) ?? "");
  const edits: Array<[string, string]> =
    d.toolName === "Write"
      ? [["", String(input.content ?? "")]]
      : Array.isArray(input.edits)
        ? input.edits.map((e: any) => [String(e.old_string ?? ""), String(e.new_string ?? "")])
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
  return [{ path, added, removed, isNew: created, isDeleted: false, diff: headTail(diffs.join("\n"), 6000, 2000) }];
}

type Draft = Omit<Action, "type" | "id" | "at" | "status"> & { failed?: boolean };

function commandAction(p: any): Draft {
  const d = p.data ?? {};
  const item = d.item ?? {};
  const detail = str(p.detail)?.replace(/^Bash: /, "");
  const command = str(item.command) ?? str(d.input?.command) ?? str(d.command) ?? str(d.rawInput?.command) ?? detail ?? "";
  const claudeOut = resultText(d.result);
  const parsedExit = /^Exit code (\d+)/.exec(claudeOut ?? "")?.[1];
  const exitCode: number | undefined =
    typeof item.exitCode === "number"
      ? item.exitCode
      : typeof d.rawOutput?.exitCode === "number"
        ? d.rawOutput.exitCode
        : parsedExit
          ? Number(parsedExit)
          : d.result?.is_error
            ? 1
            : undefined;
  const output =
    str(item.aggregatedOutput) ??
    claudeOut ??
    ([str(d.rawOutput?.stdout), str(d.rawOutput?.stderr)].filter(Boolean).join("\n") || undefined);

  const parts = humanizeCommand(command);
  let kind = parts.length ? strongestKind(parts.map((x) => x.kind)) : "run";
  const actions: any[] = Array.isArray(item.commandActions) ? item.commandActions : [];
  if (kind === "run" && actions.length && actions.every((a) => ["read", "search", "listFiles"].includes(a?.type))) {
    kind = actions.some((a) => a.type !== "read") ? "search" : "read";
  }
  const allSearch = parts.length > 0 && parts.every((x) => x.isSearch);
  const noMatch = allSearch && exitCode === 1;
  return {
    kind,
    title: parts.map((x) => x.title).join(" · ") || short(command, 120),
    hint: str(d.input?.description),
    command,
    exitCode,
    output: headTail(output),
    targets: parts.flatMap((x) => x.targets ?? []),
    noMatch: noMatch || undefined,
    failed: !noMatch && ((exitCode !== undefined && exitCode !== 0) || d.result?.is_error === true),
  };
}

function editAction(p: any): Draft {
  const files = fileChanges(p);
  const names = files.map((f) => f.path.replace(/^.*\//, ""));
  return {
    kind: "edit",
    title: files.length === 1 ? files[0]!.path : `${files.length} files: ${short(names.join(", "), 90)}`,
    files,
    targets: files.map((f) => f.path),
    output: headTail(resultText(p.data?.result), 400, 200),
    failed: p.data?.result?.is_error === true,
  };
}

function otherToolAction(p: any): Draft {
  const d = p.data ?? {};
  const item = d.item ?? {};
  const input = d.input ?? {};
  const toolName: string | undefined = str(d.toolName);
  const itemType: string = p.itemType ?? "";
  const out = headTail(resultText(d.result) ?? (item.result ? JSON.stringify(item.result) : undefined) ?? (d.rawOutput ? JSON.stringify(d.rawOutput) : undefined), 800, 400);
  const failed = d.result?.is_error === true || !!item.error || !!d.rawOutput?.error;
  const argSummary = (o: unknown) => short(JSON.stringify(o ?? {}).replace(/^\{\}$/, ""), 100);

  // Claude built-in tools
  if (toolName === "Read") {
    const range = input.offset ? `:${input.offset}-${Number(input.offset) + Number(input.limit ?? 0)}` : "";
    return { kind: "read", title: `read ${input.file_path}${range}`, targets: [input.file_path], failed };
  }
  if (toolName === "Grep")
    return { kind: "search", title: `search "${short(String(input.pattern ?? ""), 50)}"${input.path ? ` in ${input.path}` : ""}`, targets: input.path ? [input.path] : [], output: out, failed };
  if (toolName === "Glob") return { kind: "search", title: `list ${input.pattern}${input.path ? ` in ${input.path}` : ""}`, output: out, failed };
  if (toolName === "WebFetch") return { kind: "web", title: `fetch ${input.url}`, hint: str(input.prompt), output: out, failed };
  if (toolName === "WebSearch") return { kind: "web", title: `web search "${input.query}"`, output: out, failed };
  if (toolName === "Agent" || toolName === "Task")
    return { kind: "agent", title: `subagent${input.subagent_type ? ` (${input.subagent_type})` : ""}: ${input.description ?? ""}`, hint: short(String(input.prompt ?? ""), 400), output: out, failed };
  if (toolName === "AskUserQuestion")
    return { kind: "tool", title: `asked user: ${short(input.questions?.[0]?.question ?? "", 90)}`, output: out, failed };
  if (toolName === "Skill") return { kind: "tool", title: `skill ${input.skill}${input.args ? ` ${short(String(input.args), 60)}` : ""}`, failed };
  if (toolName?.startsWith("mcp__")) {
    const [, server = "", tool = ""] = toolName.split("__");
    return { kind: "tool", title: `${server} · ${tool} ${argSummary(input)}`.trim(), output: out, failed };
  }
  if (toolName) return { kind: "tool", title: `${toolName} ${argSummary(input)}`.trim(), output: out, failed };

  // Codex items
  if (item.type === "mcpToolCall") return { kind: "tool", title: `${item.server} · ${item.tool} ${argSummary(item.arguments)}`.trim(), output: out, failed };
  if (item.type === "webSearch") {
    const a = item.action ?? {};
    return { kind: "web", title: a.type === "openPage" ? `fetch ${a.url}` : `web search "${short(String(item.query ?? a.query ?? ""), 80)}"`, failed };
  }
  if (item.type === "imageView") return { kind: "read", title: `view image ${item.path ?? ""}`, targets: item.path ? [item.path] : [], failed };
  if (item.type === "collabAgentToolCall")
    return { kind: "agent", title: `subagent ${item.tool}${item.prompt ? `: ${short(String(item.prompt), 90)}` : ""}`, hint: str(item.prompt), failed: item.status === "failed" };

  // Cursor (ACP kinds). Cursor doesn't record paths for reads.
  const kindMap: Record<string, ActionKind> = { read: "read", search: "search", fetch: "web", execute: "run", edit: "edit", delete: "edit" };
  const cursorKind = kindMap[d.kind as string];
  const label = str(p.title) ?? str(p.detail) ?? itemType.replace(/_/g, " ");
  return { kind: cursorKind ?? "tool", title: label, output: out, failed };
}

function toAction(id: string, at: string, p: any, summary: string): Action {
  const itemType = p.itemType;
  const claudeTool = p.data?.toolName;
  const isFileTool = !claudeTool || ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(claudeTool);
  const draft =
    itemType === "command_execution"
      ? commandAction(p)
      : itemType === "file_change" && isFileTool
        ? editAction(p)
        : otherToolAction(p);
  const { failed, ...rest } = draft;
  if (!rest.title) rest.title = str(p.title) ?? str(summary) ?? String(itemType ?? "tool").replace(/_/g, " ");
  const status = p.status === "failed" || p.status === "declined" || failed ? "failed" : p.status === "inProgress" ? "running" : "ok";
  return { type: "action", id, at, status, ...rest };
}

/** Turns T3 activity + message rows into a time-ordered entry list. Rows must be in insertion order. */
export function normalize(activities: ActivityRow[], messages: MessageRow[], opts: { root?: string | null; home?: string } = {}): Entry[] {
  const tidy = (s: string) => {
    let out = s;
    if (opts.root) out = out.split(`${opts.root}/`).join("");
    if (opts.home) out = out.split(opts.home).join("~");
    return out;
  };

  // A tool call emits started/updated/completed rows; keep the first time and the last payload.
  const calls = new Map<string, { at: string; payload: any; summary: string }>();
  const entries: Entry[] = [];
  // Messages go first so they win timestamp ties (the sort below is stable).
  for (const m of messages) {
    if (!m.text.trim() || !["user", "assistant", "reasoning"].includes(m.role)) continue;
    entries.push({ type: "message", id: m.id, at: m.at, role: m.role as "user" | "assistant" | "reasoning", text: m.text });
  }
  // Older Codex rows have no toolCallId: pair started → completed by their detail text instead.
  const openByDetail = new Map<string, string>();
  for (const row of activities) {
    if (TOOL_LIFECYCLE.has(row.kind)) {
      let key: string = row.payload?.toolCallId ?? row.payload?.data?.toolCallId;
      if (!key) {
        const detailKey = `${row.payload?.itemType}:${row.payload?.detail ?? row.summary}`;
        key = openByDetail.get(detailKey) ?? row.id;
        if (row.kind === "tool.completed") openByDetail.delete(detailKey);
        else openByDetail.set(detailKey, key);
      }
      const prev = calls.get(key);
      calls.set(key, { at: prev?.at ?? row.at, payload: row.kind === "tool.started" && prev ? prev.payload : row.payload, summary: row.summary });
    } else if (EVENT_KINDS.has(row.kind)) {
      const detail = str(row.payload?.detail) ?? str(row.payload?.message) ?? "";
      entries.push({ type: "event", id: row.id, at: row.at, tone: row.tone === "error" ? "error" : "info", text: short(`${row.summary}${detail ? `: ${detail}` : ""}`, 400) });
    }
  }
  for (const [id, { at, payload, summary }] of calls) {
    const a = toAction(id, at, payload ?? {}, summary);
    a.title = tidy(a.title);
    if (a.targets) a.targets = a.targets.map(tidy);
    if (a.files) for (const f of a.files) f.path = tidy(f.path);
    entries.push(a);
  }
  return entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}
