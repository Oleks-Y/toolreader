// Claude Code sessions read straight from their transcripts under the Claude home
// (`projects/<dir>/<session>.jsonl`), for sessions run outside T3: the CLI, the desktop app,
// other SDK hosts. See core/claudeTranscript.ts. Ids are `claude:<sessionId>`.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { ThreadNotFound } from "../core/api.ts";
import { claudeTranscriptMeta, claudeTranscriptToRows } from "../core/claudeTranscript.ts";
import type { Labels, ThreadHead, ThreadSummary, ThreadView } from "../core/domain.ts";
import { normalize } from "../core/normalize.ts";
import { ServerConfig } from "./ServerConfig.ts";
import { ThreadStore } from "./ThreadStore.ts";

export const CLAUDE_ID_PREFIX = "claude:";
/** Lines the listing reads per file: enough for the session id, cwd and usually the title. */
const HEAD_LINES = 50;
const SESSION_FILE = /^[^/]+\/([^/]+)\.jsonl$/;

export class ClaudeTranscripts extends Context.Service<
  ClaudeTranscripts,
  {
    /** Sessions T3 doesn't run, from each file's first lines. Empty without a Claude home. */
    readonly list: Effect.Effect<ReadonlyArray<ThreadSummary>>;
    /** `id` is the bare session id (without the `claude:` prefix). */
    readonly get: (id: string, labels: Labels) => Effect.Effect<ThreadView, ThreadNotFound>;
    readonly head: (id: string) => Effect.Effect<ThreadHead, ThreadNotFound>;
  }
>()("toolreader/server/ClaudeTranscripts") {
  static readonly layer = Layer.effect(
    ClaudeTranscripts,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const store = yield* ThreadStore;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = path.join(config.claudeHome, "projects");
      /** Session id → transcript file, filled by `list`. */
      const files = new Map<string, string>();

      const summary = (
        id: string,
        cwd: string | null,
        title: string,
        updatedAt: string,
      ): ThreadSummary => ({
        id: `${CLAUDE_ID_PREFIX}${id}`,
        source: "claude",
        origin: "claude",
        title,
        projectId: `cwd:${cwd ?? "?"}`,
        projectTitle: cwd ? path.basename(cwd) : "?",
        provider: "claudeAgent",
        status: "idle",
        archived: false,
        updatedAt,
        actionCount: null,
        worktree: cwd,
      });

      const mtime = (file: string) =>
        fs.stat(file).pipe(
          Effect.map((s) => ({
            at: Option.getOrUndefined(s.mtime)?.toISOString() ?? "",
            size: Number(s.size),
          })),
          Effect.orElseSucceed(() => ({ at: "", size: 0 })),
        );

      const headLines = (file: string) =>
        fs.stream(file).pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.take(HEAD_LINES),
          Stream.runCollect,
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
        );

      const list = Effect.gen(function* () {
        const owned = yield* store.claudeSessionIds;
        const names = yield* fs
          .readDirectory(root, { recursive: true })
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
        // Top-level files only: subagent transcripts live in `<session>/subagents/`.
        const found = names.flatMap((name) => {
          const id = SESSION_FILE.exec(name)?.[1];
          return id && !owned.has(id) ? [{ id, file: path.join(root, name) }] : [];
        });
        const summaries = yield* Effect.forEach(
          found,
          ({ id, file }) =>
            Effect.gen(function* () {
              const meta = claudeTranscriptMeta(yield* headLines(file));
              if (!meta) return [];
              files.set(id, file);
              const { at } = yield* mtime(file);
              return [summary(id, meta.cwd, meta.title, at || meta.createdAt || "")];
            }),
          { concurrency: 16 },
        );
        return summaries.flat();
      }).pipe(Effect.withSpan("ClaudeTranscripts.list"));

      const fileOf = Effect.fn("ClaudeTranscripts.fileOf")(function* (id: string) {
        if (!files.has(id)) yield* list;
        const file = files.get(id);
        if (!file) return yield* new ThreadNotFound({ threadId: `${CLAUDE_ID_PREFIX}${id}` });
        return file;
      });

      // The file only grows while the session runs; size alone would miss a same-size rewrite.
      const head = Effect.fn("ClaudeTranscripts.head")(function* (id: string) {
        const { at, size } = yield* mtime(yield* fileOf(id));
        return { head: `${at}:${size}`, status: "idle" as const };
      });

      const get = Effect.fn("ClaudeTranscripts.get")(function* (id: string, labels: Labels) {
        const file = yield* fileOf(id);
        // Marker before content, as ThreadStore does: a write mid-read shows as a newer marker.
        const { head: marker } = yield* head(id);
        const lines = (yield* fs
          .readFileString(file)
          .pipe(
            Effect.mapError(() => new ThreadNotFound({ threadId: `${CLAUDE_ID_PREFIX}${id}` })),
          )).split("\n");
        const meta = claudeTranscriptMeta(lines);
        const { activities, messages } = claudeTranscriptToRows(lines);
        const cwd = meta?.cwd ?? null;
        const entries = normalize(activities, messages, { root: cwd, home: config.home });
        return {
          thread: {
            ...summary(
              id,
              cwd,
              meta?.title ?? "(untitled)",
              entries.at(-1)?.at ?? meta?.createdAt ?? "",
            ),
            actionCount: entries.filter((e) => e.type === "action").length,
            head: marker,
          },
          entries,
          labels,
        };
      });

      return ClaudeTranscripts.of({ list, get, head });
    }),
  );
}
