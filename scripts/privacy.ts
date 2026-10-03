// The privacy check behind the website's demo (scripts/privacyGate.ts runs it on site/demo data
// before it is written or published). Pure: rules in, findings out. It allows what it knows and
// reports the rest, so text no one thought of fails the build instead of shipping.

export interface PrivacyRules {
  /** Absolute paths that may appear: each one itself, or anything under it. */
  readonly allowedPaths: ReadonlyArray<string>;
  readonly allowedEmails: ReadonlyArray<string>;
  /** URL hosts that may appear, and their subdomains. */
  readonly allowedHosts: ReadonlyArray<string>;
  /** Values from this machine (home, user, git identity, hostname, local names), matched as whole words, any case. */
  readonly forbidden: ReadonlyArray<string>;
}

export interface Finding {
  /** Where the string is, e.g. `commits[1].entry.entries[3].output`. */
  readonly path: string;
  readonly reason: "path" | "email" | "url" | "machine";
  readonly match: string;
}

// Paths start a string or follow a separator, so regex literals (`/\p{L}+/gu`) and fractions
// (`2/3`) don't count; URLs are checked as URLs.
const BEFORE = String.raw`(?<=^|[\s"'\x60=(:,\[{<>|;&])`;
const ABSOLUTE = new RegExp(String.raw`${BEFORE}/[\w.-]+(?:/[\w.-]+)*`, "g");
const HOME_RELATIVE = new RegExp(String.raw`${BEFORE}~/[\w.-]+(?:/[\w.-]+)*`, "g");
const EMAIL = /[\w.%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?![\w-])/gi;
const URL_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+/gi;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function inString(
  text: string,
  rules: PrivacyRules,
): Array<{ at: number; reason: Finding["reason"]; match: string }> {
  const found: Array<{ at: number; reason: Finding["reason"]; match: string }> = [];
  const pathAllowed = (p: string) =>
    rules.allowedPaths.some((a) => p === a || p.startsWith(a.endsWith("/") ? a : `${a}/`));
  for (const m of text.matchAll(ABSOLUTE))
    if (!pathAllowed(m[0])) found.push({ at: m.index, reason: "path", match: m[0] });
  for (const m of text.matchAll(HOME_RELATIVE))
    found.push({ at: m.index, reason: "path", match: m[0] });
  for (const m of text.matchAll(EMAIL))
    if (!rules.allowedEmails.includes(m[0].toLowerCase()))
      found.push({ at: m.index, reason: "email", match: m[0] });
  for (const m of text.matchAll(URL_TEXT)) {
    const url = m[0].replace(/[.,;:!?]+$/, "");
    const host = hostOf(url);
    if (!host || !rules.allowedHosts.some((h) => host === h || host.endsWith(`.${h}`)))
      found.push({ at: m.index, reason: "url", match: url });
  }
  for (const value of rules.forbidden) {
    if (!value) continue;
    for (const m of text.matchAll(new RegExp(`(?<![\\w-])${escapeRegExp(value)}(?![\\w-])`, "gi")))
      found.push({ at: m.index, reason: "machine", match: m[0] });
  }
  return found.sort((a, b) => a.at - b.at);
}

/** Every string in `value`, object keys included, that the rules don't allow. */
export function findPrivate(value: unknown, rules: PrivacyRules): Array<Finding> {
  const findings: Array<Finding> = [];
  const check = (text: string, path: string) => {
    for (const { reason, match } of inString(text, rules)) findings.push({ path, reason, match });
  };
  const walk = (v: unknown, path: string) => {
    if (typeof v === "string") check(v, path);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        const at = /^[A-Za-z_$][\w$]*$/.test(k)
          ? path
            ? `${path}.${k}`
            : k
          : `${path}[${JSON.stringify(k)}]`;
        check(k, at);
        walk(x, at);
      }
  };
  walk(value, "");
  return findings;
}
