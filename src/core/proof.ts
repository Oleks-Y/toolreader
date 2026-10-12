// "Proof of work" artifacts: a thread (or some of its turns) exported as JSON that can be committed
// next to the change it produced and reopened in toolreader. Pure, so server and browser share it.
import * as Schema from "effect/Schema";

import { ThreadView, type Entry, type Labels } from "./domain.ts";
import { splitTurns } from "./tree.ts";

export const PROOF_FORMAT_VERSION = 1;

export const ProofScope = Schema.Struct({
  /** 1-based turn numbers as shown in the viewer (T1, T2, …), inclusive. */
  turns: Schema.NullOr(Schema.Struct({ from: Schema.Number, to: Schema.Number })),
  /** ISO time range, inclusive. */
  range: Schema.NullOr(Schema.Struct({ from: Schema.String, to: Schema.String })),
});
export type ProofScope = typeof ProofScope.Type;

export const ProofArtifact = Schema.Struct({
  formatVersion: Schema.Literal(PROOF_FORMAT_VERSION),
  exportedAt: Schema.String,
  toolreaderVersion: Schema.String,
  /** The repo the work happened in, at export time. */
  git: Schema.NullOr(
    Schema.Struct({
      branch: Schema.NullOr(Schema.String),
      head: Schema.NullOr(Schema.String),
      remote: Schema.NullOr(Schema.String),
    }),
  ),
  scope: ProofScope,
  outputs: Schema.Literals(["included", "omitted"]),
  /** How many secrets were replaced with `[redacted]`. */
  redactions: Schema.Number,
  view: ThreadView,
});
export type ProofArtifact = typeof ProofArtifact.Type;

/** Keeps the selected turns or time range. A turn's prompt stays whenever any of its entries does. */
export function selectEntries(entries: ReadonlyArray<Entry>, scope: ProofScope): Entry[] {
  const turns = splitTurns(entries);
  const out: Entry[] = [];
  turns.forEach((turn, i) => {
    const n = i + 1;
    if (scope.turns && (n < scope.turns.from || n > scope.turns.to)) return;
    const kept = scope.range
      ? turn.entries.filter((e) => e.at >= scope.range!.from && e.at <= scope.range!.to)
      : turn.entries;
    if (scope.range && kept.length === 0) return;
    if (turn.prompt) out.push(turn.prompt);
    out.push(...kept);
  });
  return out;
}

// Secret shapes, most specific first. Each keeps a harmless prefix ($1) where there is one.
// The backend runs these on every string it is sent: keep every pattern linear (bound each
// run that could start at many places), or one crafted record stalls it (`redactText` timing test).
/**
 * The JWTs in one dotted run (`a.b.c…`, no other characters), as
 * `\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}` finds them: a header starting
 * `eyJ` at a segment's start or after a `-`, then two segments of 10 or more. That regex is
 * quadratic on `eyJ-eyJ-…` (each start scans ahead for the `.`); this walks each segment once.
 */
function jwtsIn(run: string): { text: string; count: number } {
  const segments = run.split(".");
  const out: string[] = [];
  let count = 0;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    let at = segment.indexOf("eyJ");
    while (at > 0 && segment[at - 1] !== "-") at = segment.indexOf("eyJ", at + 1);
    const jwt =
      at >= 0 &&
      segment.length - at >= 13 &&
      (segments[i + 1]?.length ?? 0) >= 10 &&
      (segments[i + 2]?.length ?? 0) >= 10;
    if (!jwt) {
      out.push(segment);
      continue;
    }
    out.push(`${segment.slice(0, at)}[redacted jwt]`);
    count++;
    i += 2;
  }
  return { text: out.join("."), count };
}

const SECRET_PATTERNS: ReadonlyArray<
  readonly [RegExp, string | ((match: string) => { text: string; count: number })]
> = [
  [
    /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----(?:(?!-----BEGIN )[\s\S]){0,16384}?-----END [A-Z ]{0,40}PRIVATE KEY-----/g,
    "[redacted private key]",
  ],
  // A key left without its END line (cut off by clipping, or pasted half): the rest of the text.
  // Only a header a key body follows (a line break, raw or JSON-escaped, then base64 or
  // `Proc-Type:`): code that only names the header keeps its text.
  [
    /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----(?:\r?\n|\\(?:r\\)?n)[A-Za-z0-9+/][\s\S]*/g,
    "[redacted private key]",
  ],
  [
    /(\b(?:authorization|proxy-authorization)\s*[:=]\s*["']?(?:bearer|basic|token)\s+)[^\s"',;]+/gi,
    "$1[redacted]",
  ],
  [
    // trk_: toolreader's own backend tokens (`backend token create`).
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|trk_[A-Za-z0-9_-]{40,})/g,
    "[redacted]",
  ],
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, "[redacted]"],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, "[redacted]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[redacted]"],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, "[redacted]"],
  // JWTs: found by `jwtsIn` in each dotted run, which a regex alone can't do in linear time.
  [/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+/g, jwtsIn],
  // KEY=value / KEY: value where the name says secret (env files, exports, YAML). A value that is
  // already the placeholder stays as it is, with what follows it: redacting twice changes nothing.
  [
    /\b((?:[A-Z][A-Z0-9_]{0,255})?(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?)[A-Z0-9_]{0,255}\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|\[redacted\]|[^\s"'\n]+)/g,
    "$1[redacted]",
  ],
  // JSON fields with secret names.
  [
    /("(?:password|passwd|secret|token|apiKey|api_key|accessToken|access_token|refreshToken|refresh_token|clientSecret|client_secret|privateKey|private_key)"\s*:\s*)"[^"]*"/gi,
    '$1"[redacted]"',
  ],
  // Credentials in URLs and secret-looking query parameters.
  [/(\b[a-z][a-z0-9+.-]{0,31}:\/\/)[^/\s:@'"]+:[^/\s@'"]+@/gi, "$1[redacted]@"],
  [
    /([?&](?:token|access_token|api_key|apikey|key|secret|signature|sig|password)=)[^&\s"'#]+/gi,
    "$1[redacted]",
  ],
];

/** Replaces secret-looking substrings; returns the text and how many were replaced. */
export function redactText(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, (...args: unknown[]) => {
      if (typeof replacement === "function") {
        const found = replacement(String(args[0]));
        count += found.count;
        return found.text;
      }
      count++;
      const prefix = typeof args[1] === "string" ? args[1] : "";
      return replacement.replace("$1", prefix);
    });
  }
  return { text: out, count };
}

export type ProofOptions = { readonly outputs: boolean; readonly home?: string | undefined };

/** Redacts free text (secrets, and the home directory as `~`), counting what it replaced. */
export function redactor(home?: string) {
  let count = 0;
  const clean = (s: string) => {
    const r = redactText(home ? s.split(home).join("~") : s);
    count += r.count;
    return r.text;
  };
  return { clean, count: () => count };
}

/** Label values are free text too (Codex writes them from the session's own words). */
export const redactLabels = (labels: Labels, clean: (s: string) => string): Labels =>
  Object.fromEntries(Object.entries(labels).map(([id, label]) => [id, clean(label)]));

/** Redacts every free-text field (and drops outputs when asked). Also rewrites the home directory to `~`. */
export function redactEntries(
  entries: ReadonlyArray<Entry>,
  options: ProofOptions,
): { entries: Entry[]; redactions: number } {
  const { clean, count } = redactor(options.home);
  const maybe = (s: string | undefined) => (s === undefined ? undefined : clean(s));
  const result = entries.map((e): Entry => {
    if (e.type === "message" || e.type === "event") return { ...e, text: clean(e.text) };
    return {
      ...e,
      title: clean(e.title),
      hint: maybe(e.hint),
      command: maybe(e.command),
      output: options.outputs ? maybe(e.output) : undefined,
      parts: e.parts?.map((p) => ({ ...p, title: clean(p.title) })),
      targets: e.targets?.map(clean),
      // `addedKeys` are for matching on this machine only: never in what is exported or published.
      files: e.files?.map(({ addedKeys: _, ...f }) => ({
        ...f,
        path: clean(f.path),
        diff: maybe(f.diff),
      })),
    };
  });
  return { entries: result, redactions: count() };
}

/** File name for an artifact: `<title-slug>-<thread-id-prefix>[-t3-5].json`. */
export function proofFileName(view: ThreadView, scope: ProofScope): string {
  const slug =
    view.thread.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "thread";
  const id = view.thread.id.replace(/^[a-z]+:/, "").slice(0, 8);
  const turns = scope.turns
    ? `-t${scope.turns.from}${scope.turns.to !== scope.turns.from ? `-${scope.turns.to}` : ""}`
    : "";
  return `${slug}-${id}${turns}${scope.range ? "-range" : ""}.json`;
}
