// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { launchDetachedSync, markDetachedSync } from "./detachedSync.ts";

const session = "11111111-1111-4111-8111-111111111111";

describe("SessionEnd upload handoff", () => {
  it("returns before a slow worker finishes and leaves a private status", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "toolreader-hook-"));
    try {
      const marker = NodePath.join(home, "worker-complete");
      const script = NodePath.join(home, "worker.mjs");
      await NodeFSP.writeFile(
        script,
        `import * as fs from "node:fs"; setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2))), 3500);`,
      );
      const start = process.hrtime.bigint();
      await launchDetachedSync(home, session, "/selected/repo", script);
      expect(Number(process.hrtime.bigint() - start) / 1_000_000).toBeLessThan(2500);
      const statusPath = NodePath.join(home, "toolreader-events", session, "sync-status.json");
      expect(JSON.parse(await NodeFSP.readFile(statusPath, "utf8")).state).toBe("scheduled");
      expect((await NodeFSP.stat(statusPath)).mode & 0o777).toBe(0o600);
      for (let n = 0; n < 50; n++) {
        if (
          await NodeFSP.stat(marker).then(
            () => true,
            () => false,
          )
        )
          break;
        // @effect-diagnostics-next-line globalTimers:off
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(JSON.parse(await NodeFSP.readFile(marker, "utf8"))).toEqual([
        "history",
        "hook-sync",
        "--session",
        session,
        "--repo",
        "/selected/repo",
      ]);
      await markDetachedSync(home, session, "succeeded");
      expect(JSON.parse(await NodeFSP.readFile(statusPath, "utf8")).state).toBe("succeeded");
    } finally {
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  }, 10_000);
});
