// A transparent stdio bridge for clients which own their Codex app-server process.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";
import { ARCHIVE } from "../../core/codexArchive.ts";
import { StreamCapture, StreamRoutes } from "./capture.ts";

export async function recordAppServer(codexBin: string, codexHome: string) {
  const child = NodeChildProcess.spawn(codexBin, ["app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const routes = new StreamRoutes();
  const capture = new StreamCapture(codexHome);
  let failure: unknown;
  const fail = (error: unknown) => {
    failure ??= error;
    child.kill("SIGTERM");
  };
  const readers: NodeReadline.Interface[] = [];
  for (const [stream, direction] of [
    [process.stdin, "client"],
    [child.stdout, "server"],
  ] as const) {
    let lineBytes = 0;
    stream.on("data", (chunk: Buffer) => {
      for (const byte of chunk) {
        lineBytes = byte === 10 ? 0 : lineBytes + 1;
        if (lineBytes > ARCHIVE.lineBytes) {
          fail(new Error("App-server record exceeds 32 MiB; capture failed"));
          break;
        }
      }
    });
    const reader = NodeReadline.createInterface({ input: stream });
    readers.push(reader);
    reader.on("line", (line) => {
      try {
        for (const event of routes.event(direction, line)) void capture.record(event).catch(fail);
      } catch (e) {
        fail(e);
      }
    });
  }
  process.stdin.pipe(child.stdin);
  const drain = () => child.stdout.resume();
  child.stdout.on("data", (chunk: Buffer) => {
    if (!process.stdout.write(chunk)) child.stdout.pause();
  });
  process.stdout.on("drain", drain);
  const stop = () => child.kill("SIGTERM");
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    });
    await capture.flush();
    if (failure) throw failure;
    if (code !== 0) throw new Error(`Codex app-server exited ${String(code)}`);
  } finally {
    for (const reader of readers) reader.close();
    process.stdin.unpipe(child.stdin);
    process.stdin.pause();
    process.stdout.off("drain", drain);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}
