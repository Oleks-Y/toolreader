// "Proof of work" artifacts: a thread (or some of its turns) exported as JSON that can be committed
// next to the change it produced and reopened in toolreader. Pure, so server and browser share it.
import * as Schema from "effect/Schema";

import { ThreadView, type Entry } from "./domain.ts";
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
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[redacted private key]",
  ],
  [
    /(\b(?:authorization|proxy-authorization)\s*[:=]\s*["']?(?:bearer|basic|token)\s+)[^\s"',;]+/gi,
    "$1[redacted]",
  ],
  [
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,})/g,
    "[redacted]",
  ],
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, "[redacted]"],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, "[redacted]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[redacted]"],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[redacted jwt]"],
  // KEY=value / KEY: value where the name says secret (env files, exports, YAML).
  [
    /\b((?:[A-Z][A-Z0-9_]*)?(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?)[A-Z0-9_]*\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"'\n]+)/g,
    "$1[redacted]",
  ],
  // JSON fields with secret names.
  [
    /("(?:password|passwd|secret|token|apiKey|api_key|accessToken|access_token|refreshToken|refresh_token|clientSecret|client_secret|privateKey|private_key)"\s*:\s*)"[^"]*"/gi,
    '$1"[redacted]"',
  ],
  // Credentials in URLs and secret-looking query parameters.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@'"]+:[^/\s@'"]+@/gi, "$1[redacted]@"],
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
      count++;
      const prefix = typeof args[1] === "string" ? args[1] : "";
      return replacement.replace("$1", prefix);
    });
  }
  return { text: out, count };
}

export type ProofOptions = { readonly outputs: boolean; readonly home?: string | undefined };

/** Redacts every free-text field (and drops outputs when asked). Also rewrites the home directory to `~`. */
export function redactEntries(
  entries: ReadonlyArray<Entry>,
  options: ProofOptions,
): { entries: Entry[]; redactions: number } {
  let redactions = 0;
  const clean = (s: string) => {
    const r = redactText(options.home ? s.split(options.home).join("~") : s);
    redactions += r.count;
    return r.text;
  };
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
      files: e.files?.map((f) => ({ ...f, path: clean(f.path), diff: maybe(f.diff) })),
    };
  });
  return { entries: result, redactions };
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
