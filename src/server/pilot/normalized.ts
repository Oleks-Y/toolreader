// Send the selected Codex snapshots through the same normalized record path as history push.
// Selection is explicit: a peer can be outside the repository or have no recorded action.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";

import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import packageJson from "../../../package.json" with { type: "json" };
import { codexThreadToRows } from "../../core/codex.ts";
import { extendSnapshot } from "../../core/domain.ts";
import { LIMITS, type MediaType } from "../../core/historyApi.ts";
import { buildThreadRecord, ThreadRecordV1 } from "../../core/historyRecord.ts";
import { normalize } from "../../core/normalize.ts";
import { readRollout, rolloutMeta } from "../../core/rolloutThread.ts";
import { sha256, threadSha } from "../recordHash.ts";
import { ServerConfig } from "../ServerConfig.ts";
import { backendSettings, call, connect, HistoryFailed } from "../history/HistoryClient.ts";
import { type Blob, extractMedia } from "../history/media.ts";

const encodeThread = Schema.encodeSync(Schema.fromJsonString(ThreadRecordV1));
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const MAX_OUTPUT = 8192;

export type NormalizedPilotSource = {
  readonly id: string;
  readonly file: string;
  readonly sourceSha256: string;
  readonly parent?: string | null;
};

export type NormalizedPilotReport = {
  readonly sent: number;
  readonly unchanged: number;
  readonly skipped: ReadonlyArray<{ readonly id: string; readonly reason: string }>;
  readonly images: number;
  readonly imagesSent: number;
};

/** Normalize a selected snapshot even when it ran no action in the linking repository. */
export function normalizedPilotRecord(input: {
  readonly source: NormalizedPilotSource;
  readonly text: string;
  readonly home: string;
  readonly takenAt: string;
}) {
  const { source, text, home, takenAt } = input;
  const session = readRollout(text.split("\n"), source.file);
  const parent =
    source.parent === undefined ? rolloutMeta(text.split("\n", 1)[0] ?? "")?.parent : source.parent;
  if (!session || session.read.thread.id !== source.id) return null;
  const t = session.read.thread;
  const { activities, messages } = codexThreadToRows(session.read, session.scan);
  const entries = normalize(activities, messages, { root: t.cwd ?? null, home });
  const extracted = extractMedia(entries);
  const title = (t.preview ?? "").split("\n")[0]!.slice(0, 160) || "(untitled)";
  const snapshot = session.instructions
    ? extendSnapshot(
        session.snapshot,
        { instructionsSha: sha256(session.instructions) },
        "recorded",
      )
    : session.snapshot;
  return {
    record: buildThreadRecord({
      thread: {
        id: `codex:${source.id}`,
        title,
        source: "codex",
        provider: "codex",
        origin: t.originator ?? null,
        parent: parent ? `codex:${parent}` : null,
      },
      entries: extracted.entries,
      labels: {},
      takenAt,
      toolreaderVersion: packageJson.version,
      maxOutput: MAX_OUTPUT,
      home,
      snapshot,
      origin: { reader: "codex-rollout", sha256: source.sourceSha256 },
      sourceState: "unknown",
    }),
    blobs: extracted.blobs,
  };
}

/** A selected local source, independent of the repository-action filter in HistorySync.push. */
export const syncNormalizedPilot = Effect.fn("Pilot.syncNormalized")(function* (
  selected: ReadonlyArray<NormalizedPilotSource>,
) {
  const config = yield* ServerConfig;
  const settings = yield* backendSettings();
  const api = yield* connect(settings);
  const params = { ws: settings.workspace };
  const blobs = new Map<string, Blob>();
  const records = [];
  const takenAt = DateTime.formatIso(yield* DateTime.now);
  for (const source of selected) {
    const text = yield* Effect.tryPromise({
      try: () => NodeFSP.readFile(source.file, "utf8"),
      catch: () =>
        new HistoryFailed({ message: `Could not read selected Codex session ${source.id}` }),
    });
    const made = normalizedPilotRecord({ source, text, home: config.home, takenAt });
    if (!made)
      return yield* new HistoryFailed({
        message: `Could not normalize selected Codex session ${source.id}; identity or format changed`,
      });
    for (const [sha, blob] of made.blobs) blobs.set(sha, blob);
    records.push(made.record);
  }

  let imagesSent = 0;
  const shas = [...blobs.keys()];
  for (let i = 0; i < shas.length; i += LIMITS.ids) {
    const { enabled, missing } = yield* call(
      api.history.mediaMissing({ params, payload: { shas: shas.slice(i, i + LIMITS.ids) } }),
    );
    if (!enabled) break;
    for (const sha of missing) {
      const blob = blobs.get(sha)!;
      yield* call(
        api.history.putMedia({
          params,
          payload: { sha256: sha, mime: blob.mime as MediaType, data: blob.data },
        }),
      );
      imagesSent++;
    }
  }

  const stored = new Map<string, string>();
  for (let i = 0; i < records.length; i += LIMITS.ids) {
    const ids = records.slice(i, i + LIMITS.ids).map((r) => r.thread.id);
    const { hashes } = yield* call(api.history.hashes({ params, payload: { ids } }));
    for (const [id, hash] of Object.entries(hashes)) stored.set(id, hash);
  }
  let sent = 0;
  let unchanged = 0;
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const record of records) {
    if (stored.get(record.thread.id) === threadSha(record)) {
      unchanged++;
      continue;
    }
    const result = yield* call(
      api.history
        .putThread({ params, payload: decodeJson(encodeThread(record)) })
        .pipe(
          Effect.catchTag("NewerCopyStored", () =>
            Effect.succeed({ result: "newer" as const, removed: undefined }),
          ),
        ),
    );
    if (result.result === "newer" || result.removed)
      skipped.push({ id: record.thread.id, reason: result.removed ?? "newer" });
    else if (result.result === "same") unchanged++;
    else sent++;
  }
  return {
    sent,
    unchanged,
    skipped,
    images: blobs.size,
    imagesSent,
  } satisfies NormalizedPilotReport;
}, Effect.provide(FetchHttpClient.layer));
