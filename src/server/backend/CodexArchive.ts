// Private, opt-in Codex archive. Publication records remain on their redacted path.
import * as NodeCrypto from "node:crypto";
// Node file handles let the chunk writer sync before publishing the artifact.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  ARCHIVE,
  ArchiveStart,
  archiveEvent,
  archiveSession,
  type ArchiveLink,
} from "../../core/codexArchive.ts";
import { BackendFailed, Rejected } from "../../core/historyApi.ts";
import { archiveLines } from "../pilot/io.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const invalid = (detail: string) => new Rejected({ reason: "invalid", detail });
const io = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({
    try: f,
    catch: () => new BackendFailed({ message: "Codex archive file operation failed" }),
  });
const enabled = Effect.gen(function* () {
  const dir = yield* Config.string("TOOLREADER_CODEX_ARCHIVE_DIR").pipe(
    Config.withDefault(""),
    Effect.mapError(() => invalid("Invalid Codex archive directory configuration")),
  );
  if (!NodePath.isAbsolute(dir))
    return yield* invalid(
      "Private Codex archive is disabled; configure an absolute TOOLREADER_CODEX_ARCHIVE_DIR",
    );
  return dir;
});
const Uploads = Schema.Array(Schema.Struct({ manifest: ArchiveStart }));
const decodeUploads = Schema.decodeUnknownSync(Uploads);
const Parts = Schema.Array(Schema.Struct({ data: Schema.Uint8Array }));
const decodeParts = Schema.decodeUnknownSync(Parts);
const invalidData = () =>
  invalid(
    "Codex archive has invalid records, parts, size, hash or session id; nothing was published",
  );
const databaseFailed = () =>
  new BackendFailed({ message: "Codex archive database operation failed" });

export const startArchive = Effect.fn("CodexArchive.start")(
  function* (workspace: string, manifest: ArchiveStart) {
    yield* enabled;
    if (manifest.parts !== Math.ceil(manifest.bytes / ARCHIVE.chunkBytes))
      return yield* invalidData();
    const sql = yield* SqlClient.SqlClient;
    const id = NodeCrypto.randomUUID();
    yield* sql`INSERT INTO codex_uploads ${sql.insert({ workspace_id: workspace, id, manifest: encodeJson(manifest) })}`;
    return { uploadId: id };
  },
  Effect.catchTag("SqlError", () => Effect.fail(databaseFailed())),
);

export const archivePart = Effect.fn("CodexArchive.part")(
  function* (
    workspace: string,
    part: { readonly uploadId: string; readonly part: number; readonly data: string },
  ) {
    yield* enabled;
    const sql = yield* SqlClient.SqlClient;
    const held = decodeUploads(
      yield* sql`SELECT manifest FROM codex_uploads WHERE workspace_id=${workspace} AND id=${part.uploadId}`,
    )[0];
    const data = Buffer.from(part.data, "base64");
    if (
      !held ||
      data.toString("base64") !== part.data ||
      part.part >= held.manifest.parts ||
      data.length !==
        Math.min(ARCHIVE.chunkBytes, held.manifest.bytes - part.part * ARCHIVE.chunkBytes)
    )
      return yield* invalidData();
    yield* sql`INSERT INTO codex_upload_parts ${sql.insert({ workspace_id: workspace, upload_id: part.uploadId, part: part.part, data })}`;
    return { ok: true };
  },
  Effect.catchTag("SqlError", () => Effect.fail(databaseFailed())),
);

export const finishArchive = Effect.fn("CodexArchive.finish")(
  function* (workspace: string, uploadId: string) {
    const dir = yield* enabled;
    const sql = yield* SqlClient.SqlClient;
    const held = decodeUploads(
      yield* sql`SELECT manifest FROM codex_uploads WHERE workspace_id=${workspace} AND id=${uploadId}`,
    )[0];
    if (!held) return yield* invalidData();
    const m = held.manifest;
    // Random staging file; content-addressed final files never change once visible to readers.
    const folder = NodePath.join(dir, workspace, m.sessionId);
    yield* io(() => NodeFSP.mkdir(folder, { recursive: true, mode: 0o700 }));
    const temp = NodePath.join(folder, `.${NodeCrypto.randomUUID()}.tmp`);
    const file = NodePath.join(folder, `${m.sha256}.jsonl`);
    return yield* Effect.acquireUseRelease(
      io(() => NodeFSP.open(temp, "wx", 0o600)),
      (handle) =>
        Effect.gen(function* () {
          const hash = NodeCrypto.createHash("sha256");
          let bytes = 0;
          for (let part = 0; part < m.parts; part++) {
            const row = decodeParts(
              yield* sql`SELECT data FROM codex_upload_parts WHERE workspace_id=${workspace} AND upload_id=${uploadId} AND part=${part}`,
            )[0];
            if (!row) return yield* invalidData();
            bytes += row.data.length;
            hash.update(row.data);
            // writeFile writes all bytes even when a file-system write is short.
            yield* io(() => handle.writeFile(row.data));
          }
          if (bytes !== m.bytes || hash.digest("hex") !== m.sha256) return yield* invalidData();
          yield* io(() => handle.sync());
          yield* io(() => handle.close());
          const iterator = archiveLines(temp)[Symbol.asyncIterator]();
          return yield* Effect.acquireUseRelease(
            Effect.succeed(iterator),
            () =>
              sql.withTransaction(
                Effect.gen(function* () {
                  yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${workspace}:${m.sessionId}:${m.sha256}`},0))`;
                  const existing =
                    yield* sql`SELECT event_count,source FROM codex_artifacts WHERE workspace_id=${workspace} AND session_id=${m.sessionId} AND sha256=${m.sha256}`;
                  if (existing.length && existing[0]?.source !== (m.source ?? "rollout"))
                    return yield* invalidData();
                  if (existing.length === 0) {
                    yield* sql`INSERT INTO codex_artifacts ${sql.insert({ workspace_id: workspace, session_id: m.sessionId, sha256: m.sha256, bytes: m.bytes, event_count: 0, file_path: file, source: m.source ?? "rollout" })}`;
                    let seq = 0;
                    for (;;) {
                      const next = yield* Effect.tryPromise({
                        try: () => iterator.next(),
                        catch: invalidData,
                      });
                      if (next.done) break;
                      const event = yield* Effect.try({
                        try: () => archiveEvent(next.value, ++seq),
                        catch: invalidData,
                      });
                      if (
                        seq === 1 &&
                        (yield* Effect.try({
                          try: () => archiveSession(next.value),
                          catch: invalidData,
                        })) !== m.sessionId
                      )
                        return yield* invalidData();
                      yield* sql`INSERT INTO codex_events ${sql.insert({ workspace_id: workspace, session_id: m.sessionId, sha256: m.sha256, seq, type: event.type, at: event.at, raw: encodeJson(event.raw) })}`;
                    }
                    if (!seq) return yield* invalidData();
                    yield* sql`UPDATE codex_artifacts SET event_count=${seq} WHERE workspace_id=${workspace} AND session_id=${m.sessionId} AND sha256=${m.sha256}`;
                  }
                  // Rename before commit. A failed transaction can leave an unreferenced file, never a visible row without its file.
                  yield* io(async () => {
                    await NodeFSP.rename(temp, file);
                    const directory = await NodeFSP.open(folder, "r");
                    try {
                      await directory.sync();
                    } finally {
                      await directory.close();
                    }
                  });
                  yield* sql`INSERT INTO codex_selections ${sql.insert({ workspace_id: workspace, root_id: m.rootId, session_id: m.sessionId, sha256: m.sha256 })} ON CONFLICT DO NOTHING`;
                  yield* sql`DELETE FROM codex_uploads WHERE workspace_id=${workspace} AND id=${uploadId}`;
                  const count = yield* sql<{
                    event_count: number;
                  }>`SELECT event_count FROM codex_artifacts WHERE workspace_id=${workspace} AND session_id=${m.sessionId} AND sha256=${m.sha256}`;
                  return {
                    sessionId: m.sessionId,
                    sha256: m.sha256,
                    events: count[0]!.event_count,
                  };
                }),
              ),
            () => Effect.promise(() => iterator.return(undefined)).pipe(Effect.ignore),
          );
        }),
      (handle) =>
        Effect.promise(async () => {
          await handle.close().catch(() => {});
          await NodeFSP.rm(temp, { force: true });
        }).pipe(Effect.ignore),
    );
  },
  Effect.catchTag("SqlError", () => Effect.fail(databaseFailed())),
);

export const linkArchive = Effect.fn("CodexArchive.link")(
  function* (workspace: string, link: ArchiveLink) {
    yield* enabled;
    const sql = yield* SqlClient.SqlClient;
    const held =
      yield* sql`SELECT 1 FROM codex_artifacts WHERE workspace_id=${workspace} AND session_id=${link.sessionId} LIMIT 1`;
    if (!held.length) return yield* invalid("Sync this Codex session before linking a commit");
    yield* sql`INSERT INTO codex_commit_links ${sql.insert({ workspace_id: workspace, repo: link.repo, sha: link.sha, session_id: link.sessionId, role: link.role })} ON CONFLICT DO NOTHING`;
    return { ok: true };
  },
  Effect.catchTag("SqlError", () => Effect.fail(databaseFailed())),
);
