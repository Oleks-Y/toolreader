// Builds and writes proof-of-work artifacts (see src/core/proof.ts). Used by the HTTP API (download)
// and the `export` CLI (writes into the repo the agent changed).
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import packageJson from "../../package.json" with { type: "json" };
import { ProofWriteFailed, type ThreadNotFound } from "../core/api.ts";
import {
  PROOF_FORMAT_VERSION,
  ProofArtifact,
  proofFileName,
  redactEntries,
  redactText,
  selectEntries,
  type ProofScope,
} from "../core/proof.ts";
import { CODEX_ID_PREFIX, CodexSessions } from "./CodexSessions.ts";
import { Labeler } from "./Labeler.ts";
import { ServerConfig } from "./ServerConfig.ts";
import { ThreadStore } from "./ThreadStore.ts";

const encodeArtifact = Schema.encodeEffect(ProofArtifact);

export type ProofRequest = {
  readonly threadId: string;
  readonly scope: ProofScope;
  readonly outputs: boolean;
  /** Repo to read git info from; defaults to the thread's working directory. */
  readonly repo?: string | undefined;
};

export class Proofs extends Context.Service<
  Proofs,
  {
    readonly build: (request: ProofRequest) => Effect.Effect<ProofArtifact, ThreadNotFound>;
    /** Pretty-printed JSON, for committing (diffable) and downloads alike. */
    readonly render: (artifact: ProofArtifact) => Effect.Effect<string>;
    /** Writes to `<repo>/.agent-work/<branch>/<name>.json` and returns the path. */
    readonly write: (
      artifact: ProofArtifact,
      repo: string,
    ) => Effect.Effect<string, ProofWriteFailed>;
  }
>()("toolreader/server/Proofs") {
  static readonly layer = Layer.effect(
    Proofs,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const store = yield* ThreadStore;
      const codex = yield* CodexSessions;
      const labeler = yield* Labeler;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const git = (repo: string, args: ReadonlyArray<string>) =>
        spawner.string(ChildProcess.make("git", ["-C", repo, ...args])).pipe(
          Effect.map((s) => s.trim() || null),
          Effect.orElseSucceed(() => null),
        );

      const gitInfo = Effect.fn("Proofs.gitInfo")(function* (repo: string | null) {
        if (!repo) return null;
        const [branch, head, remote] = yield* Effect.all(
          [
            git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]),
            git(repo, ["rev-parse", "HEAD"]),
            git(repo, ["remote", "get-url", "origin"]),
          ],
          { concurrency: "unbounded" },
        );
        if (!branch && !head) return null;
        // Remote URLs can embed credentials (https://token@host/…).
        return { branch, head, remote: remote ? redactText(remote).text : null };
      });

      const build = Effect.fn("Proofs.build")(function* (request: ProofRequest) {
        const labels = yield* labeler.forThread(request.threadId);
        const view = request.threadId.startsWith(CODEX_ID_PREFIX)
          ? yield* codex.get(request.threadId.slice(CODEX_ID_PREFIX.length), labels)
          : yield* store.get(request.threadId, labels);
        const selected = selectEntries(view.entries, request.scope);
        const { entries, redactions } = redactEntries(selected, {
          outputs: request.outputs,
          home: config.home,
        });
        const ids = new Set(entries.map((e) => e.id));
        const now = yield* Clock.currentTimeMillis;
        const artifact: ProofArtifact = {
          formatVersion: PROOF_FORMAT_VERSION,
          exportedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
          toolreaderVersion: packageJson.version,
          git: yield* gitInfo(request.repo ?? view.thread.worktree),
          scope: request.scope,
          outputs: request.outputs ? "included" : "omitted",
          redactions,
          view: {
            thread: {
              ...view.thread,
              worktree: view.thread.worktree
                ? redactText(view.thread.worktree.split(config.home).join("~")).text
                : null,
              actionCount: entries.filter((e) => e.type === "action").length,
            },
            entries,
            labels: Object.fromEntries(
              Object.entries(view.labels).filter(([id]) => ids.has(id) || id.startsWith("fold:")),
            ),
          },
        };
        return artifact;
      });

      const render = (artifact: ProofArtifact) =>
        encodeArtifact(artifact).pipe(
          Effect.orDie,
          // The value is already Schema-encoded; this only indents it.
          Effect.map((encoded) => `${JSON.stringify(encoded, null, 2)}\n`),
        );

      const write = Effect.fn("Proofs.write")(function* (artifact: ProofArtifact, repo: string) {
        const branch = (artifact.git?.branch ?? "detached")
          .replace(/[^\w./-]+/g, "-")
          .replace(/\.\.+/g, ".");
        const dir = path.join(repo, ".agent-work", branch);
        const file = path.join(dir, proofFileName(artifact.view, artifact.scope));
        const json = yield* render(artifact);
        yield* fs.makeDirectory(dir, { recursive: true }).pipe(
          Effect.andThen(fs.writeFileString(file, json)),
          Effect.mapError((e) => new ProofWriteFailed({ message: e.message })),
        );
        return file;
      });

      return Proofs.of({ build, render, write });
    }),
  );
}

export const parseTurns = (value: string): Option.Option<{ from: number; to: number }> => {
  const m = /^(\d+)(?:-(\d+))?$/.exec(value.trim());
  if (!m) return Option.none();
  const from = Number(m[1]);
  const to = Number(m[2] ?? m[1]);
  return from >= 1 && to >= from ? Option.some({ from, to }) : Option.none();
};
