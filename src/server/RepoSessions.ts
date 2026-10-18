// The agent sessions that worked in a repo: every session, from the chosen sources, whose
// directory is inside one of the repo's git worktrees, read whole, with its subagent parent from
// T3. What `history sync` reads.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { ThreadNotFound } from "../core/api.ts";
import type {
  Entry,
  Labels,
  SessionOrigin,
  SessionSnapshot,
  ThreadSummary,
  ThreadView,
} from "../core/domain.ts";
import { nativeId, type LedgerThread } from "../core/ledger.ts";
import { CLAUDE_ID_PREFIX, ClaudeTranscripts } from "./ClaudeTranscripts.ts";
import { CodexRollouts, ROLLOUT_DIRS } from "./CodexRollouts.ts";
import { CODEX_ID_PREFIX, CodexSessions } from "./CodexSessions.ts";
import { Labeler } from "./Labeler.ts";
import { ServerConfig } from "./ServerConfig.ts";
import { ThreadStore } from "./ThreadStore.ts";

/** Where sessions come from. `auto`: T3 if its database exists, plus Codex rollout files and Claude Code transcripts. */
export const SESSION_SOURCES = [
  "auto",
  "t3",
  "codex-app-server",
  "codex-rollouts",
  "claude-transcripts",
] as const;
export type SessionSource = (typeof SESSION_SOURCES)[number];

export class SessionsFailed extends Schema.TaggedErrorClass<SessionsFailed>()("SessionsFailed", {
  message: Schema.String,
}) {}

export type RepoSession = {
  /** The worktree it worked in. */
  readonly root: string;
  readonly entries: ReadonlyArray<Entry>;
  readonly labels: Labels;
  readonly thread: LedgerThread;
  /** How it started, when its source recorded that. */
  readonly snapshot?: SessionSnapshot | undefined;
  /** Where it was read from, and the digest of what was read. */
  readonly origin: SessionOrigin;
};

export type Loaded = {
  readonly sources: ReadonlyArray<string>;
  /** The repo's worktrees. */
  readonly roots: ReadonlyArray<string>;
  readonly sessions: ReadonlyArray<RepoSession>;
  /** Sessions that worked here but couldn't be read: reported, so a gap isn't taken for absence. */
  readonly unread: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  /** The sessions a name means: a thread id, `codex:<id>`, or what an agent exports (`claude-code:<id>`). */
  readonly named: (name: string) => ReadonlyArray<RepoSession>;
};

export class RepoSessions extends Context.Service<
  RepoSessions,
  {
    readonly load: (repo: string, source: SessionSource) => Effect.Effect<Loaded, SessionsFailed>;
  }
>()("toolreader/server/RepoSessions") {
  static readonly layer = Layer.effect(
    RepoSessions,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const store = yield* ThreadStore;
      const codex = yield* CodexSessions;
      const rollouts = yield* CodexRollouts;
      const claude = yield* ClaudeTranscripts;
      const labeler = yield* Labeler;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));

      /** Sessions from the chosen sources that worked in this repo or one of its git worktrees. */
      const sessionsFor = Effect.fn("RepoSessions.sessionsFor")(function* (
        repo: string,
        source: SessionSource,
      ) {
        const listing = yield* spawner
          .string(ChildProcess.make("git", ["-C", repo, "worktree", "list", "--porcelain"]))
          .pipe(Effect.mapError((e) => new SessionsFailed({ message: e.message })));
        const roots = listing
          .split("\n")
          .filter((l) => l.startsWith("worktree "))
          .map((l) => l.slice("worktree ".length));
        const hasT3 = yield* exists(config.dbPath);
        const rolloutDirs = ROLLOUT_DIRS.map((dir) => path.join(config.codexHome, dir));
        const hasRollouts = (yield* Effect.forEach(rolloutDirs, exists)).some(Boolean);
        const claudeDir = path.join(config.claudeHome, "projects");
        const hasClaude = yield* exists(claudeDir);
        if (source === "t3" && !hasT3)
          return yield* new SessionsFailed({ message: `No T3 database at ${config.dbPath}` });
        if (source === "claude-transcripts" && !hasClaude)
          return yield* new SessionsFailed({ message: `No Claude Code sessions in ${claudeDir}` });
        if (source === "codex-rollouts" && !hasRollouts)
          return yield* new SessionsFailed({
            message: `No Codex sessions in ${rolloutDirs.join(" or ")}`,
          });

        const sources: string[] = [];
        const found: Array<{
          summary: ThreadSummary;
          load: (labels: Labels) => Effect.Effect<ThreadView, ThreadNotFound>;
          /** A subagent's parent, as its reader names it; others' come from T3. */
          parent?: string | null;
          reader: SessionOrigin["reader"];
        }> = [];
        const bare = (s: ThreadSummary) => s.id.slice(CODEX_ID_PREFIX.length);
        if (source === "t3" || (source === "auto" && hasT3)) {
          sources.push("t3");
          for (const s of yield* store.list)
            found.push({ summary: s, load: (l) => store.get(s.id, l), reader: "t3" });
        }
        if (source === "codex-app-server") {
          sources.push("codex-app-server");
          yield* codex.ready;
          for (const s of yield* codex.list)
            found.push({
              summary: s,
              load: (l) => codex.get(bare(s), l),
              reader: "codex-app-server",
            });
        }
        // T3 runs Codex too; the rollout listing skips the sessions T3 owns.
        if (source === "codex-rollouts" || (source === "auto" && hasRollouts)) {
          sources.push("codex-rollouts");
          for (const s of yield* rollouts.list)
            found.push({
              summary: s,
              load: (l) => rollouts.get(bare(s), l),
              reader: "codex-rollout",
            });
          // Subagents' edits land in commits too; their copy of the parent's history is skipped.
          for (const { summary: s, parent } of yield* rollouts.subagents)
            found.push({
              summary: s,
              load: (l) => rollouts.get(bare(s), l),
              parent,
              reader: "codex-rollout",
            });
        }
        // T3 runs Claude too; the transcript listing skips the sessions T3 owns.
        if (source === "claude-transcripts" || (source === "auto" && hasClaude)) {
          sources.push("claude-transcripts");
          for (const s of yield* claude.list)
            found.push({
              summary: s,
              load: (l) => claude.get(s.id.slice(CLAUDE_ID_PREFIX.length), l),
              reader: "claude-transcript",
            });
          for (const { summary: s, parent } of yield* claude.subagents)
            found.push({
              summary: s,
              load: (l) => claude.get(s.id.slice(CLAUDE_ID_PREFIX.length), l),
              parent,
              reader: "claude-transcript",
            });
        }
        // The innermost worktree holding the session's directory (worktrees can nest).
        const rootOf = (dir: string | null) =>
          roots
            .filter((root) => !!dir && (dir === root || dir.startsWith(`${root}/`)))
            .sort((a, b) => b.length - a.length)[0];
        return {
          sources,
          roots,
          found: found.flatMap((f) => {
            const root = rootOf(f.summary.worktree);
            return root ? [{ ...f, root }] : [];
          }),
        };
      });

      /** Each session that worked here, loaded once, with its subagent parent from T3. */
      const load = Effect.fn("RepoSessions.load")(function* (repo: string, source: SessionSource) {
        const { sources, found, roots } = yield* sessionsFor(repo, source);
        const { nativeIds, parents } = yield* store.lineage;
        // A T3 thread's provider session, whose own files say how it started.
        const nativeOf = new Map<string, string>();
        for (const [native, id] of nativeIds) if (!nativeOf.has(id)) nativeOf.set(id, native);
        const snapshotOf = (t: ThreadSummary) => {
          const native = t.source === "t3" ? nativeOf.get(t.id) : undefined;
          if (!native) return Effect.succeed(null);
          if (t.provider === "codex") return rollouts.snapshot(native);
          if (t.provider === "claudeAgent") return claude.snapshot(native);
          return Effect.succeed(null);
        };
        const sessions: RepoSession[] = [];
        const unread: Array<{ id: string; title: string }> = [];
        for (const { summary, load, root, parent, reader } of found) {
          const labels = yield* labeler.forThread(summary.id);
          const view = yield* load(labels).pipe(Effect.option);
          if (Option.isNone(view)) {
            unread.push({ id: summary.id, title: summary.title });
            continue;
          }
          const { entries, thread: t } = view.value;
          if (!entries.some((e) => e.type === "action")) continue;
          sessions.push({
            root,
            entries,
            labels: { ...view.value.labels },
            snapshot: view.value.snapshot ?? (yield* snapshotOf(t)) ?? undefined,
            origin: view.value.origin ?? { reader },
            thread: {
              id: t.id,
              title: t.title,
              source: t.source,
              provider: t.provider,
              origin: t.origin,
              // A parent T3 ran is known there by its own thread id.
              parent:
                parent === undefined
                  ? (parents.get(t.id) ?? null)
                  : parent && (nativeIds.get(nativeId(parent)) ?? parent),
            },
          });
        }
        // A name is a thread id, `codex:<id>`, or what an agent exports (`claude-code:<id>`),
        // which T3 knows by its provider thread.
        const named = (name: string) => {
          const id = nativeId(name);
          const ids = new Set([
            name,
            id,
            `${CODEX_ID_PREFIX}${id}`,
            `${CLAUDE_ID_PREFIX}${id}`,
            nativeIds.get(id),
          ]);
          return sessions.filter((s) => ids.has(s.thread.id));
        };
        return { sources, sessions, unread, named, roots };
      });

      return RepoSessions.of({ load });
    }),
  );
}
