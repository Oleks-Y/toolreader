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
import {
  claudeSnapshot,
  claudeTranscriptMeta,
  claudeTranscriptToRows,
} from "../core/claudeTranscript.ts";
import type {
  Labels,
  SessionSnapshot,
  ThreadHead,
  ThreadSummary,
  ThreadView,
} from "../core/domain.ts";
import { normalize } from "../core/normalize.ts";
import type { Subagent } from "./CodexRollouts.ts";
import { sha256 } from "./recordHash.ts";
import { ServerConfig } from "./ServerConfig.ts";
import { ThreadStore } from "./ThreadStore.ts";

export const CLAUDE_ID_PREFIX = "claude:";
/** Lines the listing reads per file: enough for the session id, cwd and usually the title. */
const HEAD_LINES = 50;
const SESSION_FILE = /^[^/]+\/([^/]+)\.jsonl$/;
/** `<dir>/<session>/subagents/[workflows/<run>/]agent-<id>.jsonl`: the parent session, the agent. */
const SUBAGENT_FILE = /^[^/]+\/([^/]+)\/subagents\/(?:[^/]+\/)*(agent-[^/]+)\.jsonl$/;

export class ClaudeTranscripts extends Context.Service<
  ClaudeTranscripts,
  {
    /** Sessions T3 doesn't run, from each file's first lines. Empty without a Claude home. */
    readonly list: Effect.Effect<ReadonlyArray<ThreadSummary>>;
    /** Subagent transcripts, ids `claude:agent-<id>`, each with the session that spawned it. */
    readonly subagents: Effect.Effect<ReadonlyArray<Subagent>>;
    /** `id` is the bare session id (without the `claude:` prefix). */
    readonly get: (id: string, labels: Labels) => Effect.Effect<ThreadView, ThreadNotFound>;
    readonly head: (id: string) => Effect.Effect<ThreadHead, ThreadNotFound>;
    /** How a session started, from its transcript, T3's included (T3 doesn't keep this). */
    readonly snapshot: (id: string) => Effect.Effect<SessionSnapshot | null>;
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
      /** The same for sessions T3 runs: read only for their snapshot. */
      const owned = new Map<string, string>();

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
        const t3 = yield* store.claudeSessionIds;
        const names = yield* fs
          .readDirectory(root, { recursive: true })
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
        // Top-level files only: subagent transcripts live in `<session>/subagents/`.
        const found = names.flatMap((name) => {
          const id = SESSION_FILE.exec(name)?.[1];
          if (!id) return [];
          const file = path.join(root, name);
          if (!t3.has(id)) return [{ id, file }];
          owned.set(id, file);
          return [];
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

      // Listed apart from `list`, which the viewer shows: a subagent is read through its parent there.
      const subagents = Effect.gen(function* () {
        const names = yield* fs
          .readDirectory(root, { recursive: true })
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
        const found = names.flatMap((name) => {
          const m = SUBAGENT_FILE.exec(name);
          return m ? [{ parent: m[1]!, id: m[2]!, file: path.join(root, name) }] : [];
        });
        const summaries = yield* Effect.forEach(
          found,
          ({ parent, id, file }) =>
            Effect.gen(function* () {
              const meta = claudeTranscriptMeta(yield* headLines(file));
              if (!meta) return [];
              files.set(id, file);
              const { at } = yield* mtime(file);
              return [
                {
                  summary: summary(id, meta.cwd, meta.title, at || meta.createdAt || ""),
                  parent: `${CLAUDE_ID_PREFIX}${parent}`,
                },
              ];
            }),
          { concurrency: 16 },
        );
        return summaries.flat();
      }).pipe(Effect.withSpan("ClaudeTranscripts.subagents"));

      const fileOf = Effect.fn("ClaudeTranscripts.fileOf")(function* (id: string) {
        if (!files.has(id)) yield* id.startsWith("agent-") ? subagents : list;
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
        const text = yield* fs
          .readFileString(file)
          .pipe(
            Effect.mapError(() => new ThreadNotFound({ threadId: `${CLAUDE_ID_PREFIX}${id}` })),
          );
        const lines = text.split("\n");
        const meta = claudeTranscriptMeta(lines);
        const { activities, messages } = claudeTranscriptToRows(lines, id.startsWith("agent-"));
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
          snapshot: claudeSnapshot(lines),
          origin: {
            reader: "claude-transcript" as const,
            // Without its project folder, whose name spells the session's directory (and user).
            file: path.relative(root, file).split("/").slice(1).join("/"),
            sha256: sha256(text),
          },
        };
      });

      const snapshot = Effect.fn("ClaudeTranscripts.snapshot")(function* (id: string) {
        if (files.size + owned.size === 0) yield* list;
        const file = files.get(id) ?? owned.get(id);
        if (!file) return null;
        const text = yield* fs.readFileString(file).pipe(Effect.option);
        return Option.isSome(text) ? claudeSnapshot(text.value.split("\n")) : null;
      });

      return ClaudeTranscripts.of({ list, subagents, snapshot, get, head });
    }),
  );
}
