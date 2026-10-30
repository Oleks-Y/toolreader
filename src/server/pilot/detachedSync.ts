// SessionEnd has a three-second cap. Its selected upload runs in a separate process.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { SessionId } from "../../core/codexArchive.ts";
import { CAPTURE_DIR } from "./capture.ts";

const decodeId = Schema.decodeUnknownSync(SessionId);
type SyncState = "scheduled" | "running" | "succeeded" | "failed";

async function writeStatus(home: string, session: string, state: SyncState) {
  const dir = NodePath.join(home, CAPTURE_DIR, decodeId(session));
  await NodeFSP.mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = NodePath.join(dir, `.sync-${NodeCrypto.randomUUID()}.tmp`);
  const target = NodePath.join(dir, "sync-status.json");
  await NodeFSP.writeFile(
    temp,
    JSON.stringify({ state, at: DateTime.formatIso(DateTime.nowUnsafe()) }) + "\n",
    {
      mode: 0o600,
      flag: "wx",
    },
  );
  await NodeFSP.rename(temp, target);
}

export async function launchDetachedSync(
  home: string,
  session: string,
  repo: string,
  command = process.argv[1]!,
) {
  await writeStatus(home, session, "scheduled");
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      NodePath.resolve(command),
      "history",
      "hook-sync",
      "--session",
      decodeId(session),
      "--repo",
      repo,
    ],
    { detached: true, stdio: "ignore", env: process.env },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
  } catch (error) {
    await writeStatus(home, session, "failed");
    throw error;
  }
}

export async function markDetachedSync(home: string, session: string, state: SyncState) {
  await writeStatus(home, session, state);
}
