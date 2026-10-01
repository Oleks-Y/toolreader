// The static ledger page (`toolreader ledger site`): the site template from `dist/site/index.html`
// (viewer script and styles inlined, see vite.site.config.ts) with one range's entries inlined.
import type { LedgerCommit, LedgerRange } from "./ledger.ts";
import { redactEntries, redactLabels, redactor } from "./proof.ts";

/** Where `ledgerSiteHtml` puts the data; the site build writes it into the template once. */
export const SITE_DATA_MARKER = "<!--toolreader:ledger-data-->";
/** Element id of the inlined `LedgerRange` JSON, read by `src/web/site.tsx`. */
export const SITE_DATA_ID = "ledger-data";

/**
 * What a published page or log may show of a range: every free-text field redacted again
 * (commit subjects come straight from git, and older entries may predate a pattern), and the
 * repo by name (`owner/name` from the remote, else the directory name), never its local path.
 */
export function publicRange(range: LedgerRange, home?: string): LedgerRange {
  const { clean } = redactor(home);
  const commit = (c: LedgerCommit): LedgerCommit => ({ ...c, subject: clean(c.subject) });
  const remotePath = range.remoteUrl ? new URL(range.remoteUrl).pathname.slice(1) : "";
  return {
    repo: remotePath || range.repo.split(/[\\/]/).findLast(Boolean) || "repo",
    range: clean(range.range),
    remoteUrl: range.remoteUrl,
    commits: range.commits.map((c) => ({
      ...c,
      commit: commit(c.commit),
      entry: c.entry && {
        ...c.entry,
        commit: commit(c.entry.commit),
        thread: { ...c.entry.thread, title: clean(c.entry.thread.title) },
        entries: redactEntries(c.entry.entries, { outputs: true, home }).entries,
        labels: redactLabels(c.entry.labels, clean),
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
