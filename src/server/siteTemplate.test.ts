import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { SITE_DATA_MARKER } from "../core/ledgerSite.ts";

describe("ledger site template", () => {
  it.live("is one HTML file that loads nothing else, so it opens from file:// and offline", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = path.join(import.meta.dirname, "..", "..");
      const out = yield* fs.makeTempDirectoryScoped({ prefix: "toolreader-site-build-" });
      const build = yield* spawner.spawn(
        ChildProcess.make(
          path.join(root, "node_modules", ".bin", "vp"),
          ["build", "-c", "vite.site.config.ts", "--outDir", out, "--logLevel", "error"],
          { cwd: root },
        ),
      );
      const [err, code] = yield* Effect.all(
        [build.stderr.pipe(Stream.decodeText(), Stream.mkString), build.exitCode],
        { concurrency: "unbounded" },
      );
      assert.strictEqual(Number(code), 0, err);
      assert.deepStrictEqual(yield* fs.readDirectory(out), ["index.html"]);
      const html = yield* fs.readFileString(path.join(out, "index.html"));
      assert.strictEqual(html.split(SITE_DATA_MARKER).length, 2, "one place for the data");

      const style = html.slice(html.indexOf("<style>") + 7, html.indexOf("</style>"));
      const open = html.indexOf("<script>");
      const close = html.lastIndexOf("</script>");
      const script = html.slice(open + 8, close);
      assert.isAbove(script.length, 100_000, "the viewer is inlined");
      assert.notMatch(script, /<\/script|<!--/i, "nothing in the script ends it early");
      assert.notMatch(style, /url\(|@import/, "no fonts or sheets to fetch");
      // A classic script after the root and the data it reads; no module scripts, no other files.
      const shell =
        html.slice(0, html.indexOf("<style>")) + html.slice(html.indexOf("</style>"), open);
      assert.notMatch(shell + html.slice(close), /\bsrc=|\bhref=|<link|type="module"/);
      assert.isBelow(shell.indexOf('id="root"'), shell.indexOf(SITE_DATA_MARKER));
      // Nothing loads even if session text slips a URL past the viewer: only the page's own
      // script (by hash) runs, and images may only be inline data.
      const hash = NodeCrypto.createHash("sha256").update(script).digest("base64");
      assert.include(
        shell,
        `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'" />`,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
