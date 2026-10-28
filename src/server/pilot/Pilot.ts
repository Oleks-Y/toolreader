// The pilot reads only selected local Codex artifacts. It never loads RepoSessions or T3.
import * as NodeCrypto from "node:crypto";
// Exact byte snapshots and bounded file reads use Node file handles.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  ARCHIVE,
  SessionId,
  archiveEvent,
  archivePeers,
  archiveSession,
} from "../../core/codexArchive.ts";
import { backendSettings, call, connect, HistoryFailed } from "../history/HistoryClient.ts";
import { ServerConfig } from "../ServerConfig.ts";
import { archiveLines } from "./io.ts";

const io = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({
    try: f,
    catch: () =>
      new HistoryFailed({
        message: "Codex pilot file operation failed; no successful sync reported",
      }),
  });
const decodeId = Schema.decodeUnknownEffect(SessionId);
const validateId = (id: string) =>
  decodeId(id.replace(/^codex:/, "")).pipe(
    Effect.mapError(() => new HistoryFailed({ message: "Expected a Codex session UUID" })),
  );

/** Directory names only. Unselected session files are never opened. */
export async function findArtifact(home: string, id: string) {
  const found: string[] = [];
  const walk = async (dir: string) => {
    let entries;
    try {
      entries = await NodeFSP.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (e instanceof Error && "code" in e && e.code === "ENOENT") return;
      throw e;
    }
    for (const entry of entries) {
      const file = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (
        entry.isFile() &&
        entry.name.startsWith("rollout-") &&
        entry.name.endsWith(`-${id}.jsonl`)
      )
        found.push(file);
    }
  };
  await walk(NodePath.join(home, "sessions"));
  await walk(NodePath.join(home, "archived_sessions"));
  if (found.length !== 1)
    throw new Error(
      `Expected one local artifact for selected session ${id}; found ${found.length}`,
    );
  return found[0]!;
}

/** Freeze the available prefix at open time. Do not race a growing rollout during hashing/upload. */
export async function snapshotArtifact(source: string, destination: string) {
  const input = await NodeFSP.open(source, "r");
  try {
    const size = (await input.stat()).size;
    if (size <= 0 || size > ARCHIVE.maxBytes)
      throw new Error("Codex artifact must be 1 byte to 1 GiB; nothing truncated");
    const output = await NodeFSP.open(destination, "wx", 0o600);
    try {
      const buffer = Buffer.alloc(ARCHIVE.chunkBytes);
      const hash = NodeCrypto.createHash("sha256");
      let at = 0;
      while (at < size) {
        const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, size - at), at);
        if (!bytesRead) throw new Error("Codex artifact shrank during snapshot");
        const bytes = buffer.subarray(0, bytesRead);
        await output.writeFile(bytes);
        hash.update(bytes);
        at += bytesRead;
      }
      return { bytes: size, sha256: hash.digest("hex") };
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

export async function inspectArtifact(file: string, sessionId: string) {
  const peers = new Set<string>();
  let seq = 0;
  for await (const line of archiveLines(file)) {
    const event = archiveEvent(line, ++seq);
    if (seq === 1 && archiveSession(line) !== sessionId)
      throw new Error("Selected artifact has another session id");
    for (const peer of archivePeers(event.raw)) if (peer !== sessionId) peers.add(peer);
  }
  if (!seq) throw new Error("Empty Codex artifact");
  return { events: seq, peers: [...peers] };
}

export type PilotOptions = {
  readonly repo: string;
  readonly session: string | undefined;
  readonly related: ReadonlyArray<string>;
  readonly sha: string | undefined;
  readonly role: "implemented" | "tested" | "reviewed" | "deployed";
};

export const syncPilot = Effect.fn("Pilot.sync")(function* (options: PilotOptions) {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const own =
    options.session ??
    Option.getOrUndefined(yield* Config.string("CODEX_THREAD_ID").pipe(Config.option));
  if (!own)
    return yield* new HistoryFailed({
      message: "No CODEX_THREAD_ID. Give --session for this local Codex chat.",
    });
  const rootId = yield* validateId(own);
  const explicit = yield* Effect.forEach(options.related, validateId);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const git = (args: string[]) =>
    spawner.string(ChildProcess.make("git", ["-C", path.resolve(options.repo), ...args]));
  const sha = options.sha
    ? (yield* git(["rev-parse", "--verify", `${options.sha}^{commit}`])).trim()
    : null;
  const origin = sha ? (yield* git(["remote", "get-url", "origin"])).trim() : "";
  const match = /(?:[:/])([^/:]+\/[^/]+?)(?:\.git)?$/.exec(origin);
  if (sha && !match)
    return yield* new HistoryFailed({
      message: "A commit link needs an origin URL with owner/repo",
    });
  const settings = yield* backendSettings();
  const api = yield* connect(settings);
  const params = { ws: settings.workspace };
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "toolreader-codex-" });
      const selected: Array<{
        id: string;
        file: string;
        bytes: number;
        sha256: string;
        events: number;
      }> = [];
      const select = Effect.fn("Pilot.select")(function* (id: string) {
        const source = yield* Effect.tryPromise({
          try: () => findArtifact(config.codexHome, id),
          catch: () =>
            new HistoryFailed({
              message: `Selected local artifact ${id} is missing or ambiguous; sync failed`,
            }),
        });
        const file = path.join(temporary, `${id}.jsonl`);
        const snapshot = yield* io(() => snapshotArtifact(source, file));
        const inspected = yield* Effect.tryPromise({
          try: () => inspectArtifact(file, id),
          catch: () =>
            new HistoryFailed({
              message: `Selected artifact ${id} is invalid, incomplete or exceeds the 32 MiB record limit; nothing truncated`,
            }),
        });
        selected.push({ id, file, ...snapshot, events: inspected.events });
        return inspected.peers;
      });
      const peers = yield* select(rootId);
      // Direct root peers only. Never walk their relations, parent trees or unrelated repo sessions.
      for (const id of new Set([...peers, ...explicit])) if (id !== rootId) yield* select(id);
      // Validate every selected snapshot before the first upload. There is no automatic retry.
      for (const item of selected) {
        const { uploadId } = yield* call(
          api.history.codexStart({
            params,
            payload: {
              sessionId: item.id,
              rootId,
              sha256: item.sha256,
              bytes: item.bytes,
              parts: Math.ceil(item.bytes / ARCHIVE.chunkBytes),
            },
          }),
        );
        yield* Effect.acquireUseRelease(
          io(() => NodeFSP.open(item.file, "r")),
          (handle) =>
            Effect.gen(function* () {
              for (let part = 0; part < Math.ceil(item.bytes / ARCHIVE.chunkBytes); part++) {
                const bytes = Buffer.alloc(
                  Math.min(ARCHIVE.chunkBytes, item.bytes - part * ARCHIVE.chunkBytes),
                );
                let at = 0;
                while (at < bytes.length) {
                  const read = yield* io(() =>
                    handle.read(bytes, at, bytes.length - at, part * ARCHIVE.chunkBytes + at),
                  );
                  if (!read.bytesRead)
                    return yield* new HistoryFailed({ message: "Snapshot shrank during upload" });
                  at += read.bytesRead;
                }
                yield* call(
                  api.history.codexPart({
                    params,
                    payload: { uploadId, part, data: bytes.toString("base64") },
                  }),
                );
              }
            }),
          (handle) => io(() => handle.close()).pipe(Effect.ignore),
        );
        // Large sessions can need longer than the normal read request timeout.
        const result = yield* api.history.codexFinish({ params, payload: { uploadId } }).pipe(
          Effect.timeout("30 minutes"),
          Effect.mapError(
            () =>
              new HistoryFailed({
                message: `Finalize failed for ${item.id}; sync failed, earlier session uploads may exist`,
              }),
          ),
        );
        if (result.sha256 !== item.sha256 || result.events !== item.events)
          return yield* new HistoryFailed({
            message: "Archive receipt did not match the snapshot; sync failed",
          });
        yield* Console.log(
          `Archived ${item.id}: ${item.bytes} bytes, ${item.events} complete events, sha256 ${item.sha256}`,
        );
      }
      if (sha && match) {
        yield* call(
          api.history.codexLink({
            params,
            payload: { repo: match[1]!, sha, sessionId: rootId, role: options.role },
          }),
        );
        yield* Console.log(`Linked ${rootId} to ${sha} as ${options.role}`);
      }
      yield* Console.log(
        `Synced ${selected.length} selected Codex sessions. No PR relation stored.`,
      );
    }),
  );
}, Effect.provide(FetchHttpClient.layer));
