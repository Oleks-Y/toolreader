// Links an agent declares itself: `toolreader history link --sha X [--role R] [--turns 3-5,9 |
// --entry ID…] [--session ID] [--environment E] [--tested-sha S] [--note TEXT]` (or `unlink`), run
// as a command inside its session. The declaration needs no
// storage of its own: the command and its output are part of the session's history, so a sync
// finds them there, with the turn they ran in. The output names the full SHA (`history link:
// <sha> …`), so `--sha HEAD` still means the commit it meant then. Pure.
import type { Entry } from "./domain.ts";
import type { CommitHistory, ThreadLink } from "./history.ts";
import { turnId } from "./history.ts";
import { splitCommand, unwrapShell } from "./shell.ts";
import { splitTurns } from "./tree.ts";

/**
 * What a link claims about the commit: its thread wrote it (`implemented`, the default), or
 * tested, reviewed or deployed it. A claim of relevance, not proof of success: the linked entries
 * say how it went. A thread can hold several roles on one commit.
 */
export const EVIDENCE_ROLES = ["implemented", "tested", "reviewed", "deployed"] as const;
export type EvidenceRole = (typeof EVIDENCE_ROLES)[number];
const isRole = (s: string): s is EvidenceRole =>
  (EVIDENCE_ROLES as ReadonlyArray<string>).includes(s);

export type Declaration = {
  readonly kind: "link" | "unlink";
  /** Full, as the command printed it. */
  readonly sha: string;
  /** 1-based, as the viewer numbers them; null: since the session's previous declaration. */
  readonly turns: ReadonlyArray<number> | null;
  /** Another session's name; null: the declaring session itself. */
  readonly session: string | null;
  readonly note: string | null;
  /** A link's claim (absent: implemented); an unlink's (absent: every role the thread has). */
  readonly role?: EvidenceRole;
  /** The entries that show it (`--entry`, repeatable), instead of turns. */
  readonly entries?: ReadonlyArray<string>;
  /** Where it ran (`--environment staging`), and the commit it ran on (`--tested-sha`). */
  readonly environment?: string;
  readonly testedSha?: string;
};

/**
 * What `history link` prints first: the full SHA it resolved, and the revision it was given, so a
 * sync pairs each declaration in a command with its own line.
 */
export const declaredLine = (kind: "link" | "unlink", sha: string, rev: string) =>
  `history ${kind}: ${sha} for ${rev.replace(/\s+/g, "")}`;
const DECLARED_ALL = /^history (link|unlink): ([0-9a-f]{40,64}) for (\S+)/gm;

/** `3-5,9` → [3, 4, 5, 9]; null when it isn't a list of turns and ranges. */
export function parseTurns(spec: string): number[] | null {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (!m) return null;
    const from = Number(m[1]);
    const to = Number(m[2] ?? m[1]);
    if (from < 1 || to < from || to - from > 10_000) return null;
    for (let n = from; n <= to; n++) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Where `history` sits in a stage that runs the toolreader CLI (`toolreader`, `npx toolreader`,
 * `node …/bin.mjs`, past `VAR=x` and global flags), or -1.
 */
function historyAt(words: ReadonlyArray<string>): number {
  let i = 0;
  while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i]!)) i++;
  const base = (w: string | undefined) => w?.replace(/^.*\//, "") ?? "";
  if (base(words[i]) === "toolreader") i += 1;
  else if (["npx", "bunx"].includes(base(words[i])) && words[i + 1] === "toolreader") i += 2;
  else if (
    ["node", "tsx", "bun"].includes(base(words[i])) &&
    /bin\.(?:mjs|ts)$/.test(words[i + 1] ?? "")
  )
    i += 2;
  else return -1;
  while (i < words.length && words[i]!.startsWith("-")) i += words[i] === "--log-level" ? 2 : 1;
  return words[i] === "history" && (words[i + 1] === "link" || words[i + 1] === "unlink") ? i : -1;
}

/**
 * The declarations a shell command made: each `toolreader history link|unlink` in it (an agent may
 * chain several) that printed its `history link: <sha> for <rev>` line. One that didn't print it
 * didn't run or failed (`a || b`, a check that refused it), and declares nothing.
 */
export function parseDeclarations(command: string, output?: string): Declaration[] {
  const printed = output ? [...output.matchAll(DECLARED_ALL)] : [];
  const used = new Set<number>();
  const found: Declaration[] = [];
  for (const pipeline of splitCommand(unwrapShell(command)))
    for (const words of pipeline) {
      const at = historyAt(words);
      if (at < 0) continue;
      const kind = words[at + 1] as "link" | "unlink";
      const all = new Map<string, string[]>();
      const rest = words.slice(at + 2);
      for (let i = 0; i < rest.length; i++) {
        const m = /^--([a-z-]+)(?:=(.*))?$/.exec(rest[i]!);
        if (!m) continue;
        all.set(m[1]!, [...(all.get(m[1]!) ?? []), m[2] ?? rest[++i] ?? ""]);
      }
      const flags = { get: (name: string) => all.get(name)?.at(-1) };
      const rev = (flags.get("sha") ?? "").replace(/\s+/g, "");
      const said = printed.findIndex((m, k) => !used.has(k) && m[1] === kind && m[3] === rev);
      if (said < 0) continue;
      used.add(said);
      const sha = printed[said]![2]!;
      const spec = flags.get("turns");
      const turns = spec === undefined ? null : parseTurns(spec);
      if (spec !== undefined && turns === null) continue;
      const role = flags.get("role");
      // The CLI refuses another role, so it never printed its line; a hand-made one declares nothing.
      if (role !== undefined && !isRole(role)) continue;
      const entries = all.get("entry") ?? [];
      const environment = flags.get("environment");
      const testedSha = flags.get("tested-sha");
      found.push({
        kind,
        sha,
        turns,
        session: flags.get("session") ?? null,
        note: flags.get("note") ?? null,
        ...(role ? { role } : {}),
        ...(entries.length > 0 ? { entries } : {}),
        ...(environment ? { environment } : {}),
        ...(testedSha ? { testedSha } : {}),
      });
    }
  return found;
}

/** The first declaration a shell command makes, or null. */
export const parseDeclaration = (command: string, output?: string): Declaration | null =>
  parseDeclarations(command, output)[0] ?? null;

/** A declaration as found in a session, with where it was made. */
export type Declared = Declaration & {
  /** The session that ran it. */
  readonly by: string;
  readonly at: string;
  /** 1-based number of the turn it ran in, in the declaring session. */
  readonly turn: number;
};

/**
 * Every declaration a session made, oldest first: commands that ran and didn't fail. One without
 * `--turns` covers the turns after the session's previous declaration, through its own.
 */
export function declarationsIn(threadId: string, entries: ReadonlyArray<Entry>): Declared[] {
  const found: Declared[] = [];
  let previous = 0;
  splitTurns(entries).forEach((t, i) => {
    for (const e of t.entries) {
      if (e.type !== "action" || e.status === "failed" || !e.command) continue;
      for (const d of parseDeclarations(e.command, e.output)) {
        // Since the previous declaration, through this turn: a second commit declared in the same
        // turn as the first still covers that turn.
        const from = previous === i + 1 ? i + 1 : previous + 1;
        const turns =
          d.turns ??
          (d.session || d.entries
            ? null
            : Array.from({ length: i + 2 - from }, (_, k) => from + k));
        found.push({ ...d, turns, by: threadId, at: e.at, turn: i + 1 });
        if (!d.session) previous = i + 1;
      }
    }
  });
  return found;
}

/** The turn ids of `numbers` (1-based) in a thread; numbers past its end are dropped. */
export function turnIds(entries: ReadonlyArray<Entry>, numbers: ReadonlyArray<number>): string[] {
  const turns = splitTurns(entries);
  return numbers.flatMap((n) => {
    const t = turns[n - 1];
    return t ? [turnId(t.prompt, t.entries)] : [];
  });
}

export type ResolvedDeclaration = {
  readonly kind: "link" | "unlink";
  /** The commit it is about. */
  readonly sha: string;
  readonly threadId: string;
  readonly turns: ReadonlyArray<string>;
  readonly note: string | null;
  readonly by: string;
  readonly at: string;
  readonly role?: EvidenceRole | undefined;
  /** Entry ids of the thread, when it named entries instead of turns. */
  readonly entries?: ReadonlyArray<string> | undefined;
  readonly environment?: string | undefined;
  readonly testedSha?: string | undefined;
};

/** A link's key on a commit: one thread can hold each role once. */
export const linkKey = (threadId: string, role: EvidenceRole | undefined) =>
  `${threadId}\u0000${role ?? "implemented"}`;

/**
 * A commit's links with its agents' declarations applied, in the order they were made: a declared
 * link replaces what matching found for that thread (it keeps the lines matching counted), and an
 * unlink drops the thread whatever found it. Declared links come first.
 */
export function applyDeclarations(
  history: CommitHistory,
  declarations: ReadonlyArray<ResolvedDeclaration>,
): CommitHistory {
  const links = new Map<string, ThreadLink>(
    history.links.map((l) => [linkKey(l.threadId, l.role), l]),
  );
  const declared = new Set<string>();
  const unlinked: Array<{ threadId: string; role?: EvidenceRole }> = [];
  for (const d of [...declarations]
    .filter((d) => d.sha === history.sha)
    .sort((a, b) => (a.at < b.at ? -1 : 1))) {
    if (d.kind === "unlink") {
      for (const [key, l] of links)
        if (l.threadId === d.threadId && (!d.role || (l.role ?? "implemented") === d.role)) {
          links.delete(key);
          declared.delete(key);
        }
      // Carried to the backend, which keeps links other machines sent: so it drops this one too.
      unlinked.push({ threadId: d.threadId, ...(d.role ? { role: d.role } : {}) });
      continue;
    }
    const key = linkKey(d.threadId, d.role);
    const role = d.role && d.role !== "implemented" ? d.role : undefined;
    links.set(key, {
      threadId: d.threadId,
      turns: d.turns,
      via: "asserted",
      lines: links.get(key)?.lines ?? 0,
      ...(role ? { role } : {}),
      ...(d.entries?.length ? { entries: d.entries } : {}),
      ...(d.environment ? { environment: d.environment } : {}),
      ...(d.testedSha ? { testedSha: d.testedSha } : {}),
      ...(d.note ? { note: d.note } : {}),
      ...(d.by !== d.threadId ? { declaredBy: d.by } : {}),
    });
    declared.add(key);
  }
  const all = [...links.entries()];
  // Lines only an unlinked thread wrote aren't explained anymore.
  const explained = history.hits
    ? new Set(all.flatMap(([, l]) => (l.role ? [] : [...(history.hits!.get(l.threadId) ?? [])])))
        .size
    : history.explained;
  return {
    ...history,
    explained,
    links: [
      ...all.filter(([k]) => declared.has(k)).map(([, l]) => l),
      ...all.filter(([k]) => !declared.has(k)).map(([, l]) => l),
    ],
    ...(unlinked.length > 0 ? { unlinked } : {}),
  };
}

/**
 * Whether a shell command runs `git commit` (past `-C dir`, `-c k=v` and other global flags; not
 * `--dry-run`): what Claude Code's hook reminds the agent to declare after.
 */
export function isGitCommit(command: string): boolean {
  return splitCommand(unwrapShell(command)).some((pipeline) =>
    pipeline.some((words) => {
      let i = 0;
      while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i]!)) i++;
      if (words[i]?.replace(/^.*\//, "") !== "git") return false;
      i++;
      while (i < words.length && words[i]!.startsWith("-")) i += /^-[Cc]$/.test(words[i]!) ? 2 : 1;
      return words[i] === "commit" && !words.includes("--dry-run");
    }),
  );
}
