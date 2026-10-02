// `pnpm run site:build`: the public website, site/ → site/dist. The landing page and its images
// are copied, with the docs/ci example workflows inserted where index.html names them
// (`<!--ci:agent-ledger.yml-->`), so the page shows the files as they are. The demo is the ledger
// page template (dist/site/index.html, built by `vp build -c vite.site.config.ts` first) filled
// with site/demo/ledger.json, as `toolreader ledger site` fills it, so it runs the current viewer.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { LedgerRange } from "../src/core/ledger.ts";
import { ledgerSiteHtml } from "../src/core/ledgerSite.ts";

class SiteBuildFailed extends Schema.TaggedErrorClass<SiteBuildFailed>()("SiteBuildFailed", {
  message: Schema.String,
}) {}

const decodeRange = Schema.decodeUnknownEffect(Schema.fromJsonString(LedgerRange));

const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const build = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(import.meta.dirname, "..");
  const site = path.join(root, "site");
  const out = path.join(site, "dist");

  yield* fs.remove(out, { recursive: true, force: true });
  yield* fs.makeDirectory(path.join(out, "demo"), { recursive: true });
  yield* fs.copyFile(path.join(site, "style.css"), path.join(out, "style.css"));
  yield* fs.copy(path.join(site, "img"), path.join(out, "img"));

  let index = yield* fs.readFileString(path.join(site, "index.html"));
  for (const [marker, name] of index.matchAll(/<!--ci:([\w.-]+)-->/g)) {
    const workflow = yield* fs.readFileString(path.join(root, "docs", "ci", name!));
    index = index.replace(marker, () => escapeHtml(workflow.trimEnd()));
  }
  yield* fs.writeFileString(path.join(out, "index.html"), index);

  const template = yield* fs.readFileString(path.join(root, "dist", "site", "index.html"));
  const range = yield* decodeRange(
    yield* fs.readFileString(path.join(site, "demo", "ledger.json")),
  );
  const demo = ledgerSiteHtml(template, range);
  if (!demo)
    return yield* new SiteBuildFailed({ message: "dist/site/index.html has no data marker" });
  yield* fs.writeFileString(path.join(out, "demo", "index.html"), demo);
  yield* Effect.log(`${out}: index.html, demo/index.html (${range.commits.length} commits)`);
});

build.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
