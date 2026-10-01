// The static ledger page (`toolreader ledger site`): the site template from `dist/site/index.html`
// (viewer script and styles inlined, see vite.site.config.ts) with one range's entries inlined.
import type { LedgerRange } from "./ledger.ts";

/** Where `ledgerSiteHtml` puts the data; the site build writes it into the template once. */
export const SITE_DATA_MARKER = "<!--toolreader:ledger-data-->";
/** Element id of the inlined `LedgerRange` JSON, read by `src/web/site.tsx`. */
export const SITE_DATA_ID = "ledger-data";

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
