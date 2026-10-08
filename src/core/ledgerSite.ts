// The static ledger page (`toolreader ledger site`): the site template from `dist/site/index.html`
// (viewer script and styles inlined, see vite.site.config.ts) with one range's entries inlined.
import * as Schema from "effect/Schema";

import { LedgerRange, type LedgerCommit } from "./ledger.ts";
import { redactEntries, redactLabels, redactor } from "./proof.ts";

/** Where `ledgerSiteHtml` puts the data; the site build writes it into the template once. */
export const SITE_DATA_MARKER = "<!--toolreader:ledger-data-->";
/** Element id of the inlined `LedgerRange` JSON, read by `src/web/site.tsx`. */
export const SITE_DATA_ID = "ledger-data";

const RangeJson = Schema.fromJsonString(LedgerRange);
const encodeRange = Schema.encodeSync(RangeJson);
const decodeRange = Schema.decodeSync(RangeJson);
const encodeString = Schema.encodeSync(Schema.fromJsonString(Schema.String));

/**
 * Every mention of the repo's own path, in any field, as `.` (`/x/repo/src/a.ts` → `./src/a.ts`).
 * Entries store paths under the home directory as `~/…`, so that form is matched too.
 */
function withoutRepoPath(range: LedgerRange, home?: string): LedgerRange {
  if (!range.repo) return range;
  const forms = [range.repo];
  if (home && range.repo.startsWith(`${home}/`)) forms.push(`~${range.repo.slice(home.length)}`);
  // Matched in the JSON text, escaped as it appears there, so no field is missed.
  const pattern = forms
    .map((p) =>
      encodeString(p)
        .slice(1, -1)
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("|");
  return decodeRange(encodeRange(range).replace(new RegExp(`(?:${pattern})(?![\\w.-])`, "g"), "."));
}

/**
 * What a published page or log may show of a range: every free-text field redacted again
 * (commit subjects come straight from git, and older entries may predate a pattern), and the
 * repo by name (`owner/name` from the remote, else the directory name), never its local path:
 * where the session text mentions it, it reads `.`.
 */
export function publicRange(local: LedgerRange, home?: string): LedgerRange {
  const { clean } = redactor(home);
  const commit = (c: LedgerCommit): LedgerCommit => ({ ...c, subject: clean(c.subject) });
  const remotePath = local.remoteUrl ? new URL(local.remoteUrl).pathname.slice(1) : "";
  const range = withoutRepoPath(local, home);
  return {
    repo: remotePath || local.repo.split(/[\\/]/).findLast(Boolean) || "repo",
    range: clean(range.range),
    remoteUrl: range.remoteUrl,
    commits: range.commits.map((c) => ({
      ...c,
      commit: commit(c.commit),
      entry: c.entry && {
        ...c.entry,
        commit: commit(c.entry.commit),
        links: c.entry.links.map((l) => ({
          ...l,
          thread: { ...l.thread, title: clean(l.thread.title) },
          entries: redactEntries(l.entries, { outputs: true, home }).entries,
          labels: redactLabels(l.labels, clean),
        })),
        notes: c.entry.notes.map((n) => ({ ...n, text: clean(n.text) })),
      },
    })),
  };
}

/** The page for one range, or null when the template has no data marker. */
export function ledgerSiteHtml(template: string, range: LedgerRange): string | null {
  if (!template.includes(SITE_DATA_MARKER)) return null;
  // Escaping `<` keeps any text in the entries from closing the script element.
  const json = JSON.stringify(range).replace(/</g, "\\u003c");
  return template.replace(
    SITE_DATA_MARKER,
    () => `<script type="application/json" id="${SITE_DATA_ID}">${json}</script>`,
  );
}
