// Takes checkpoints (src/core/checkpoint.ts): finds a session by any name agents or toolreader give
// it, reads it once, with T3's per-turn model and token usage, and hands the result to the sink
// (Postgres directly, for now).
// `toolreader checkpoint put` takes one named session; `collect` takes each link of a commit range.
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import packageJson from "../../../package.json" with { type: "json" };
import { ThreadNotFound } from "../../core/api.ts";
import type { PutResult } from "../../core/backendApi.ts";
import { buildCheckpoint, type Checkpoint, type TurnMeta } from "../../core/checkpoint.ts";
import type { Labels, ThreadView } from "../../core/domain.ts";
import { nativeId, remoteWebUrl, type FoundLink } from "../../core/ledger.ts";
import type { LinkCommit } from "../../core/linking.ts";
import { redactText } from "../../core/proof.ts";
import { CLAUDE_ID_PREFIX, ClaudeTranscripts } from "../ClaudeTranscripts.ts";
import { CodexRollouts } from "../CodexRollouts.ts";
import { CODEX_ID_PREFIX } from "../CodexSessions.ts";
import { Labeler } from "../Labeler.ts";
import { ServerConfig } from "../ServerConfig.ts";
import { ThreadStore } from "../ThreadStore.ts";

export class CheckpointFailed extends Schema.TaggedErrorClass<CheckpointFailed>()(
  "CheckpointFailed",
  { message: Schema.String },
) {}

export type TakeRequest = {
  /** The repo it belongs to; the session's own directory by default. */
  readonly repo: string | null;
  readonly replace: boolean;
  readonly outputs: boolean;
  readonly maxOutput: number;
} & (
  | {
      /** A T3 thread id, `codex:<id>`, `claude-code:<id>` (what agents export) or `claude:<id>`. */
      readonly session: string;
      /** `manual`: the whole session. */
      readonly trigger: "manual";
    }
  | {
      /** One link of `Ledger.scope`: its thread, and exactly the window the link names. */
      readonly trigger: "commit";
      readonly link: { readonly commit: LinkCommit; readonly found: FoundLink };
      /** The repo's worktrees, so paths inside them count as the commit's files. */
      readonly roots?: ReadonlyArray<string>;
    }
);

/**
 * What became of a record: stored (`PutResult`), `queued` in the outbox for the next run (the
 * backend was unreachable or refused the request), or `rejected` (never stored, never retried).
 */
export type Sent = PutResult["result"] | "queued";
export type SendResult = { readonly result: Sent; readonly detail: string | null };
export type RewritePair = { readonly oldSha: string; readonly newSha: string };
export type Flushed = {
  readonly sent: ReadonlyArray<SendResult & { readonly id: string }>;
  /** Why sending stopped; what is left waits for the next run. */
  readonly blocked: string | null;
  /** Entries queued for another backend or workspace, left alone. */
  readonly elsewhere: number;
};

/** Where records go: Postgres directly (`directSink.ts`), or a backend that may queue them. */
export class CheckpointSink extends Context.Service<
  CheckpointSink,
  {
    readonly put: (
      checkpoint: Checkpoint,
      options: { readonly replace: boolean },
    ) => Effect.Effect<SendResult, CheckpointFailed>;
    /** git's old → new pairs after an amend or rebase, for `repo` (owner/name). */
    readonly rewrite: (
      repo: string,
      pairs: ReadonlyArray<RewritePair>,
    ) => Effect.Effect<SendResult, CheckpointFailed>;
    /** Sends what earlier runs couldn't (the outbox), first thing in a run. */
    readonly flush: () => Effect.Effect<Flushed, CheckpointFailed>;
  }
>()("toolreader/server/checkpoints/Checkpoints/CheckpointSink") {}

/** How T3 names a provider, as the `Agent-Session` trailer names its sessions. */
const SESSION_PREFIX: Record<string, string> = { codex: "codex:", claudeAgent: "claude-code:" };

export class Checkpoints extends Context.Service<
  Checkpoints,
  {
    readonly take: (
      request: TakeRequest,
    ) => Effect.Effect<SendResult & { readonly checkpoint: Checkpoint }, CheckpointFailed>;
  }
>()("toolreader/server/checkpoints/Checkpoints") {
  static readonly layer = Layer.effect(
    Checkpoints,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const store = yield* ThreadStore;
      const rollouts = yield* CodexRollouts;
      const claude = yield* ClaudeTranscripts;
      const labeler = yield* Labeler;
      const sink = yield* CheckpointSink;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const git = (repo: string, args: ReadonlyArray<string>) =>
        spawner.string(ChildProcess.make("git", ["-C", repo, ...args])).pipe(
          Effect.map((s) => s.trim() || null),
          Effect.orElseSucceed(() => null),
        );

      /** The session, by whichever name: T3 first (it runs Codex and Claude too), then their files. */
      const resolve = Effect.fn("Checkpoints.resolve")(function* (name: string) {
        const { nativeIds, parents } = yield* store.lineage;
        const bare = nativeId(name).replace(/^claude:/, "");
        const t3Id = nativeIds.get(bare) ?? (name === bare ? name : undefined);
        const read = (
          id: string,
          get: (labels: Labels) => Effect.Effect<ThreadView, ThreadNotFound>,
        ) => Effect.flatMap(labeler.forThread(id), get);
        let view: ThreadView;
        let turns: ReadonlyArray<TurnMeta> = [];
        if (t3Id !== undefined) {
          view = yield* read(t3Id, (labels) => store.get(t3Id, labels));
          turns = yield* store.turnMeta(t3Id);
        } else if (name.startsWith(CODEX_ID_PREFIX)) {
          view = yield* read(name, (labels) => rollouts.get(bare, labels));
        } else {
          view = yield* read(`${CLAUDE_ID_PREFIX}${bare}`, (labels) => claude.get(bare, labels));
        }
        // A T3 thread asked for by its own id is named by its provider's session when T3 knows
        // exactly one: lineage doesn't say which provider an id is (a thread can have a V1 cursor,
        // a V2 native id, or sessions of two providers). `claude:<id>` (toolreader's id) and
        // `claude-code:<id>` (the trailer's) are one session. The name is not content: the store's
        // content hash leaves it out.
        const natives = [...nativeIds].filter(([, thread]) => thread === view.thread.id);
        const prefix = SESSION_PREFIX[view.thread.provider ?? ""];
        const session =
          name !== bare
            ? name.replace(/^claude:/, "claude-code:")
            : natives.length === 1 && prefix
              ? `${prefix}${natives[0]![0]}`
              : null;
        return { view, turns, session, parent: parents.get(view.thread.id) ?? null };
      });

      /** Name (`owner/name` from origin, else the directory), branch and HEAD of the repo. */
      const repoInfo = Effect.fn("Checkpoints.repoInfo")(function* (dir: string | null) {
        if (!dir) return { name: "unknown", worktree: null, branch: null, head: null };
        const [top, branch, head, remote] = yield* Effect.all(
          [
            git(dir, ["rev-parse", "--show-toplevel"]),
            git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]),
            git(dir, ["rev-parse", "HEAD"]),
            git(dir, ["remote", "get-url", "origin"]),
          ],
          { concurrency: "unbounded" },
        );
        const web = remoteWebUrl(remote ? redactText(remote).text : null);
        return {
          name: (web ? new URL(web).pathname.slice(1) : "") || path.basename(top ?? dir),
          worktree: top ?? dir,
          branch,
          head,
        };
      });

      const take = Effect.fn("Checkpoints.take")(
        function* (request: TakeRequest) {
          const link = request.trigger === "commit" ? request.link : null;
          const name =
            request.trigger === "commit" ? request.link.found.thread.id : request.session;
          const { view, turns, session, parent } = yield* resolve(name);
          const segment = link ? link.found.segment : view.entries;
          if (segment.length === 0)
            return yield* new CheckpointFailed({ message: `${name} has no history to checkpoint` });
          const now = yield* Clock.currentTimeMillis;
          const t = view.thread;
          yield* Effect.annotateCurrentSpan({ trigger: request.trigger, entries: segment.length });
          const repo = yield* repoInfo(request.repo ?? t.worktree);
          // Pure, but its own span: redaction and turn summaries are the steps worth timing.
          const checkpoint = yield* Effect.sync(() =>
            buildCheckpoint({
              trigger: request.trigger,
              takenAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
              toolreaderVersion: packageJson.version,
              session,
              thread: {
                id: t.id,
                title: t.title,
                source: t.source,
                provider: t.provider,
                origin: t.origin,
                parent,
              },
              repo,
              commit: link && {
                commit: link.commit.commit,
                role: link.found.role,
                via: link.found.via,
                reviewedSha: link.found.reviewedSha,
                paths: link.commit.paths,
              },
              roots: request.trigger === "commit" ? request.roots : undefined,
              segment,
              labels: link ? link.found.labels : view.labels,
              turnMeta: turns,
              outputs: request.outputs,
              maxOutput: request.maxOutput,
              home: config.home,
            }),
          ).pipe(
            Effect.tap((c) =>
              Effect.annotateCurrentSpan({
                id: c.id,
                redactions: c.redactions,
                turns: c.turns.length,
              }),
            ),
            Effect.withSpan("Checkpoints.build"),
          );
          const sent = yield* sink.put(checkpoint, { replace: request.replace });
          yield* Effect.annotateCurrentSpan("result", sent.result);
          return { checkpoint, ...sent };
        },
        Effect.catchTags({
          ThreadNotFound: (e) =>
            Effect.fail(new CheckpointFailed({ message: `No session ${e.threadId}` })),
        }),
      );

      return Checkpoints.of({ take });
    }),
  );
}
