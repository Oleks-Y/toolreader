// Entry of the static ledger page: LedgerPage on the range `toolreader ledger site` inlined.
import * as Schema from "effect/Schema";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { LedgerRange } from "../core/ledger.ts";
import { SITE_DATA_ID } from "../core/ledgerSite.ts";
import { LedgerPage } from "./LedgerPage.tsx";
import { applySavedTheme } from "./theme.tsx";
import "./themes.css";
import "./style.css";

const decodeRange = Schema.decodeUnknownSync(Schema.fromJsonString(LedgerRange));

applySavedTheme();
const data = decodeRange(document.getElementById(SITE_DATA_ID)?.textContent ?? "");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LedgerPage repo={data.repo} range={data.range} inline={data} />
  </StrictMode>,
);
