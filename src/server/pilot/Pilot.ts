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
  type ArtifactSource,
  SessionId,
  archiveEvent,
  archivePeers,
  archiveSession,
} from "../../core/codexArchive.ts";
import { LIMITS, type MediaType } from "../../core/historyApi.ts";
import { backendSettings, call, connect, HistoryFailed } from "../history/HistoryClient.ts";
import { ServerConfig } from "../ServerConfig.ts";
import { capturedArtifacts } from "./capture.ts";
import { filterRollout, type FilteredMedia } from "./filteredRollout.ts";
import { archiveLines } from "./io.ts";
import { syncNormalizedPilot } from "./normalized.ts";

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
  readonly includeDirs: ReadonlyArray<string>;
  readonly redactFile?: string;
  readonly peerSelection?: "direct" | "none";
  readonly retainExact: boolean;
  readonly sha: string | undefined;
  readonly role: "implemented" | "tested" | "reviewed" | "deployed";
  readonly quiet?: boolean;
};

export const syncPilot = Effect.fn("Pilot.sync")(function* (options: PilotOptions) {
  const log = (message: string) => (options.quiet ? Effect.void : Console.log(message));
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
  const repoRoot =
    (yield* options.sha
      ? git(["rev-parse", "--show-toplevel"])
      : git(["rev-parse", "--show-toplevel"]).pipe(
          Effect.orElseSucceed(() => path.resolve(options.repo)),
        )).trim() || path.resolve(options.repo);
  const sha = options.sha
    ? (yield* git(["rev-parse", "--verify", `${options.sha}^{commit}`])).trim()
    : null;
  if (options.sha && !sha)
    return yield* new HistoryFailed({ message: "The requested commit could not be resolved" });
  const origin = sha ? (yield* git(["remote", "get-url", "origin"])).trim() : "";
  const match = /(?:[:/])([^/:]+\/[^/]+?)(?:\.git)?$/.exec(origin);
  if (sha && !match)
    return yield* new HistoryFailed({
      message: "A commit link needs an origin URL with owner/repo",
    });
  const settings = yield* backendSettings();
  const extraRedactions = options.redactFile
    ? yield* io(async () => {
        const values: unknown = JSON.parse(await NodeFSP.readFile(options.redactFile!, "utf8"));
        if (!Array.isArray(values) || values.some((v) => typeof v !== "string" || v.length < 3))
          throw new Error("Expected a JSON array of strings of at least three characters");
        return values as string[];
      })
    : [];
  const api = yield* connect(settings);
  const params = { ws: settings.workspace };
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "toolreader-codex-" });
      const selected: Array<{
        id: string;
        source: ArtifactSource;
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
        selected.push({ id, source: "rollout", file, ...snapshot, events: inspected.events });
        return inspected.peers;
      });
      const peers = yield* select(rootId);
      // Direct root peers only. Never walk their relations, parent trees or unrelated repo sessions.
      if (options.peerSelection !== "none")
        for (const id of new Set([...peers, ...explicit])) if (id !== rootId) yield* select(id);
      for (const id of new Set(selected.map((s) => s.id))) {
        for (const capture of yield* io(() => capturedArtifacts(config.codexHome, id))) {
          const file = path.join(temporary, `${id}-${selected.length}.jsonl`);
          const snapshot = yield* io(() => snapshotArtifact(capture.file, file));
          const inspected = yield* io(() => inspectArtifact(file, id));
          selected.push({
            id,
            source: capture.source,
            file,
            ...snapshot,
            events: inspected.events,
          });
        }
      }
      // Filter every selected source before any archive upload. Only filtered files leave this host.
      const media = new Map<string, FilteredMedia>();
      const filtered: Array<
        (typeof selected)[number] & {
          sourceSha256: string;
          includedDirectories: string[];
        }
      > = [];
      let missingMedia = 0;
      let mediaBytes = 0;
      for (const item of selected) {
        const file = path.join(temporary, `${item.id}-${filtered.length}.filtered.jsonl`);
        const copy = yield* io(() =>
          filterRollout({
            source: item.file,
            destination: file,
            repoRoot,
            includeDirs: options.includeDirs,
            extraRedactions,
            putMedia: async (blob) => {
              media.set(blob.sha256, blob);
            },
          }),
        );
        if (copy.events !== item.events)
          return yield* new HistoryFailed({ message: "Filtering changed Codex event count" });
        missingMedia += copy.missingMedia;
        mediaBytes += copy.mediaBytes;
        filtered.push({
          ...item,
          sourceSha256: item.sha256,
          file,
          bytes: copy.bytes,
          sha256: copy.sha256,
          includedDirectories: [...copy.selectedDirs],
        });
      }
      const mediaHashes = [...media.keys()];
      for (let i = 0; i < mediaHashes.length; i += LIMITS.ids) {
        const batch = mediaHashes.slice(i, i + LIMITS.ids);
        const status = yield* call(api.history.mediaMissing({ params, payload: { shas: batch } }));
        if (!status.enabled)
          return yield* new HistoryFailed({
            message: "Filtered history contains media, but this workspace has no media bucket",
          });
        for (const hash of status.missing) {
          const blob = media.get(hash)!;
          yield* call(
            api.history.putMedia({
              params,
              payload: { sha256: blob.sha256, mime: blob.mime as MediaType, data: blob.data },
            }),
          );
        }
      }
      // Exact copies need both an explicit CLI flag and backend opt-in.
      const uploads = [
        ...(options.retainExact
          ? selected.map((item) => ({ ...item, copyKind: "exact" as const }))
          : []),
        ...filtered.map((item) => ({ ...item, copyKind: "filtered" as const })),
      ];
      for (const item of uploads) {
        const { uploadId } = yield* call(
          api.history.codexStart({
            params,
            payload: {
              sessionId: item.id,
              source: item.source,
              rootId,
              copyKind: item.copyKind,
              ...(item.copyKind === "filtered"
                ? {
                    sourceSha256: item.sourceSha256,
                    includedDirectories: item.includedDirectories,
                  }
                : {}),
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
        yield* log(
          `${item.copyKind === "filtered" ? "Filtered" : "Retained exact"} ${item.id}: ${item.bytes} bytes, ${item.events} complete events, version ${item.sha256}`,
        );
      }
      const normalized = yield* syncNormalizedPilot(
        selected
          .filter((item) => item.source === "rollout")
          .map((item) => ({
            id: item.id,
            file: filtered.find((copy) => copy.id === item.id && copy.source === "rollout")!.file,
            sourceSha256: item.sha256,
          })),
      );
      yield* log(
        `Normalized: ${normalized.sent} sent, ${normalized.unchanged} unchanged, ${normalized.skipped.length} skipped. Media: ${media.size} objects (${mediaBytes} bytes), ${missingMedia} missing references.`,
      );
      for (const item of normalized.skipped)
        yield* log(`Normalized ${item.id} skipped: ${item.reason}`);
      if (sha && match) {
        yield* call(
          api.history.codexLink({
            params,
            payload: { repo: match[1]!, sha, sessionId: rootId, role: options.role },
          }),
        );
        yield* log(`Linked ${rootId} to ${sha} as ${options.role}`);
      }
      yield* log(
        `Synced ${new Set(selected.map((s) => s.id)).size} selected Codex sessions (${filtered.length} filtered, ${uploads.length - filtered.length} exact artifacts). No PR relation stored.`,
      );
    }),
  );
}, Effect.provide(FetchHttpClient.layer));
