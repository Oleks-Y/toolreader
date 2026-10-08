// What a ledger entry may carry off this machine. Secrets are redacted when the entry is built
// (proof.ts); this hides what belongs to the machine rather than the project: paths in home
// directories outside the repo, emails, and local names (user, host, git identity, sibling
// projects, skills, the config's `private` list, and spans an agent found). `anonymize` keeps the
// structure with placeholders; `remove` drops whatever carries a hit. Pure: Ledger.ts applies it to
// every entry it writes, and `ledger sanitize` to the whole branch.
import type { Action, Entry } from "./domain.ts";
import type { LedgerEntry } from "./ledger.ts";
import { ABSOLUTE, EMAIL, HOME_RELATIVE, escapeRegExp } from "./privacy.ts";

export const SANITIZE_MODES = ["anonymize", "remove"] as const;
export type SanitizeMode = (typeof SANITIZE_MODES)[number];

/** A substring to hide wherever it appears; it reads `<kind>`. */
export interface Span {
  readonly text: string;
  readonly kind: string;
}

export interface SanitizeRules {
  /** Absolute path of the repo: it reads `.`. */
  readonly repo: string;
  readonly home: string;
  /** Path prefixes (`~/…` or absolute) and names that may stay. */
  readonly allow: ReadonlyArray<string>;
  /** Names to hide as whole words, any case; `-`, `_`, `.`, `%2F` and a regex `\b` count as word breaks. */
  readonly names: ReadonlyArray<string>;
  readonly spans: ReadonlyArray<Span>;
}

/** Where people keep their own files; other absolute paths (`/usr/bin`, `/api/threads`) stay. */
const HOME_ROOTS = /^\/(?:Users|home|Volumes)\/|^\/root(?:\/|$)/;
/** Addresses that name no one. */
export const PUBLIC_EMAIL =
  /(?:^noreply@|@users\.noreply\.github\.com$|@example\.(?:com|org|net)$|\.test$)/i;
const NOT_PATH_CHAR = String.raw`(?![\w.-])`;

const alternation = (items: Iterable<string>) =>
  [...new Set(items)]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** `clean(text)`: the text with every hit replaced, and how many there were. */
export function textSanitizer(rules: SanitizeRules) {
  const tilde = (p: string) =>
    p === rules.home || p.startsWith(`${rules.home}/`) ? `~${p.slice(rules.home.length)}` : p;
  // URLs carry paths encoded (`?repo=%2FUsers%2Fme%2Fapp`); those forms count too.
  const repoForms = [rules.repo, tilde(rules.repo), encodeURIComponent(rules.repo)];
  const repoPattern = new RegExp(`(?:${alternation(repoForms)})${NOT_PATH_CHAR}`, "g");
  const homePattern = new RegExp(`${escapeRegExp(rules.home)}(?=/|[^\\w.-]|$)`, "g");
  // An encoded home path reads as a whole: `%2Fhome%2Fme%2Fclients%2Facme`.
  const encodedHome = new RegExp(
    `${escapeRegExp(encodeURIComponent(rules.home))}(?![\\w.~-])((?:%2F[\\w.~-]+)*)`,
    "gi",
  );
  const allowedPaths = rules.allow.filter((a) => a.startsWith("~") || a.startsWith("/")).map(tilde);
  const allowedNames = new Set(rules.allow.map((a) => a.toLowerCase()));
  const names = rules.names.filter((n) => n.length >= 3 && !allowedNames.has(n.toLowerCase()));
  const namePattern =
    names.length > 0
      ? new RegExp(
          `(?:(?<![A-Za-z0-9])|(?<=%2F|\\\\b))(?:${alternation(names)})(?![A-Za-z0-9])`,
          "gi",
        )
      : null;
  const spans = [...rules.spans]
    .filter((s) => s.text.length >= 3)
    .sort((a, b) => b.text.length - a.text.length);
  const spanPattern =
    spans.length > 0 ? new RegExp(alternation(spans.map((s) => s.text)), "gi") : null;
  const spanKind = new Map(spans.map((s) => [s.text.toLowerCase(), s.kind]));
  const pathAllowed = (p: string) =>
    allowedPaths.some((a) => p === a || p.startsWith(a.endsWith("/") ? a : `${a}/`));

  return (text: string): { text: string; hits: number } => {
    let hits = 0;
    const hit = (replacement: string) => {
      hits++;
      return replacement;
    };
    let out = text.replace(repoPattern, ".").replace(homePattern, "~");
    out = out.replace(encodedHome, (_, rest: string) => {
      const p = `~${safeDecode(rest)}`;
      return rest === "" || pathAllowed(p) ? `~${rest}` : hit("<path>");
    });
    out = out.replace(HOME_RELATIVE, (p) => (pathAllowed(p) ? p : hit("<path>")));
    out = out.replace(ABSOLUTE, (p) => (HOME_ROOTS.test(p) && !pathAllowed(p) ? hit("<path>") : p));
    // Whole addresses first: a name in the local part must not leave the domain behind.
    out = out.replace(EMAIL, (e) => (PUBLIC_EMAIL.test(e) ? e : hit("<email>")));
    if (spanPattern)
      out = out.replace(spanPattern, (m) => hit(`<${spanKind.get(m.toLowerCase()) ?? "private"}>`));
    if (namePattern) out = out.replace(namePattern, () => hit("<private>"));
    return { text: out, hits };
  };
}

/** The entry as it may leave the machine, and how many hits it had. */
export function sanitizeEntry(
  entry: LedgerEntry,
  rules: SanitizeRules,
  mode: SanitizeMode,
): { entry: LedgerEntry; hits: number } {
  const clean = textSanitizer(rules);
  let total = 0;
  // In `remove` mode a field with hits is dropped, so it reads as undefined.
  const field = (s: string): { text: string; hit: boolean } => {
    const r = clean(s);
    total += r.hits;
    return { text: r.text, hit: r.hits > 0 };
  };
  const keep = (s: string | undefined) => {
    if (s === undefined) return { value: undefined, hit: false };
    const r = field(s);
    return { value: mode === "remove" && r.hit ? undefined : r.text, hit: r.hit };
  };

  const action = (a: Action): Action | null => {
    const title = field(a.title);
    const hint = keep(a.hint);
    const command = keep(a.command);
    const parts = a.parts?.map((p) => ({ ...p, title: field(p.title) }));
    const targets = a.targets?.map(field);
    const named = [title.hit, hint.hit, command.hit, ...(parts ?? []).map((p) => p.title.hit)]
      .concat((targets ?? []).map((t) => t.hit))
      .some(Boolean);
    // The action itself names something private: in `remove` mode it goes whole.
    if (mode === "remove" && named) return null;
    const output = keep(a.output);
    const files = a.files?.flatMap((f) => {
      const path = field(f.path);
      const diff = keep(f.diff);
      if (mode === "remove" && (path.hit || diff.hit)) return [];
      return [{ ...f, path: path.text, ...(f.diff === undefined ? {} : { diff: diff.value }) }];
    });
    const result: Action = {
      ...a,
      title: title.text,
      hint: hint.value,
      command: command.value,
      output: output.value,
      parts: parts?.map((p) => ({ ...p, title: p.title.text })),
      targets: targets?.map((t) => t.text),
      files,
    };
    if (output.value === undefined) delete (result as { clipped?: number }).clipped;
    return result;
  };

  const history = (list: ReadonlyArray<Entry>, labels: Readonly<Record<string, string>>) => {
    const entries = list.flatMap((e): Entry[] => {
      if (e.type === "action") {
        const a = action(e);
        return a ? [a] : [];
      }
      const text = field(e.text);
      return mode === "remove" && text.hit ? [] : [{ ...e, text: text.text }];
    });
    const ids = new Set(entries.map((e) => e.id));
    const kept = Object.fromEntries(
      Object.entries(labels).flatMap(([id, label]) => {
        if (!ids.has(id) && !id.startsWith("fold:")) return [];
        const l = field(label);
        return mode === "remove" && l.hit ? [] : [[id, l.text]];
      }),
    );
    return { entries, labels: kept };
  };
  // Commit subjects and thread titles can't be dropped; they are anonymized in either mode.
  const subject = field(entry.commit.subject).text;
  // Repo paths are the commit's own, but a name can still be private (`clients/acme/…`); like
  // titles they are anonymized in either mode, the same way everywhere they appear.
  const path = (p: string) => field(p).text;
  const links = entry.links.map((l) => ({
    ...l,
    thread: { ...l.thread, title: field(l.thread.title).text },
    files: l.files.map(path),
    ...history(l.entries, l.labels),
  }));
  const notes = entry.notes.flatMap((n) => {
    const text = field(n.text);
    return mode === "remove" && text.hit
      ? []
      : [{ ...n, text: text.text, file: n.file === null ? null : path(n.file) }];
  });
  const files = entry.files.map((f) => ({ ...f, path: path(f.path) }));
  return {
    entry: {
      ...entry,
      commit: { ...entry.commit, subject },
      links,
      files,
      notes,
      redactions: entry.redactions + total,
    },
    hits: total,
  };
}

/** Every distinct free-text string of the entries, for an agent to read. */
export function entryTexts(entries: ReadonlyArray<LedgerEntry>): string[] {
  const texts = new Set<string>();
  const add = (s: string | undefined) => s && texts.add(s);
  for (const e of entries) {
    add(e.commit.subject);
    for (const n of e.notes) add(n.text);
    for (const f of e.files) add(f.path);
    for (const l of e.links) {
      add(l.thread.title);
      for (const label of Object.values(l.labels)) add(label);
      for (const x of l.entries) {
        if (x.type !== "action") {
          add(x.text);
          continue;
        }
        for (const s of [x.title, x.hint, x.command, x.output]) add(s);
        for (const p of x.parts ?? []) add(p.title);
        for (const t of x.targets ?? []) add(t);
        for (const f of x.files ?? []) {
          add(f.path);
          add(f.diff);
        }
      }
    }
  }
  return [...texts];
}
