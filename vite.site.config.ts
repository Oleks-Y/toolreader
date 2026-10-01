// The static ledger page: `vp build -c vite.site.config.ts` writes dist/site/index.html, the
// template `toolreader ledger site` fills with a range (src/core/ledgerSite.ts).
import * as NodeCrypto from "node:crypto";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite-plus";

import { SITE_DATA_MARKER } from "./src/core/ledgerSite.ts";

/**
 * Folds the bundle into one HTML file with a classic inline script: Chrome refuses module
 * scripts and chunk imports from file://, and one file is easy to upload as an artifact.
 * Its CSP lets only that script (by hash) run and nothing load: the page shows untrusted
 * session text, and the inlined data is JSON, which no CSP rule needs to allow.
 */
const singleFile: Plugin = {
  name: "toolreader:single-file",
  enforce: "post",
  generateBundle(_, bundle) {
    let js = "";
    let css = "";
    for (const [name, out] of Object.entries(bundle)) {
      if (out.type === "chunk") js += out.code;
      else if (name.endsWith(".css")) css += String(out.source);
      else continue;
      delete bundle[name];
    }
    // Inline, these sequences would end the element early; escaped, they mean the same.
    const safe = (text: string, tag: string) =>
      text.replaceAll(`</${tag}`, `<\\/${tag}`).replaceAll("<!--", "<\\!--");
    const script = safe(js, "script");
    const csp = [
      "default-src 'none'",
      `script-src 'sha256-${NodeCrypto.createHash("sha256").update(script).digest("base64")}'`,
      "style-src 'unsafe-inline'",
      "img-src data:",
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; ");
    this.emitFile({
      type: "asset",
      fileName: "index.html",
      source: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>agent ledger</title>
    <style>${safe(css, "style")}</style>
  </head>
  <body>
    <div id="root"></div>
    ${SITE_DATA_MARKER}
    <script>${script}</script>
  </body>
</html>
`,
    });
  },
};

export default defineConfig({
  plugins: [react(), singleFile],
  build: {
    outDir: "dist/site",
    cssCodeSplit: false,
    rollupOptions: {
      input: "src/web/site.tsx",
      output: { format: "iife", inlineDynamicImports: true },
    },
  },
});
