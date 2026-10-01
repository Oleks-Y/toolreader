// The commit ledger (see src/core/ledger.ts): `sync` writes entries for agent-made commits onto the
// `agent-ledger` branch with git plumbing (never touching the working tree); `range` reads them back.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { LedgerFailed } from "../core/api.ts";
import type { Entry } from "../core/domain.ts";
import {
  findCommitActions,
  LEDGER_BRANCH,
  LEDGER_FORMAT_VERSION,
  LedgerEntry,
  ledgerPath,
  matchCommit,
  remoteWebUrl,
  segmentFor,
  type CommitAction,
  type LedgerCommit,
  type LedgerCommitView,
  type LedgerRange,
} from "../core/ledger.ts";
import { redactEntries } from "../core/proof.ts";
import { CODEX_ID_PREFIX, CodexSessions } from "./CodexSessions.ts";
import { Labeler } from "./Labeler.ts";
import { ServerConfig } from "./ServerConfig.ts";
import { ThreadStore } from "./ThreadStore.ts";

const LEDGER_REF = `refs/heads/${LEDGER_BRANCH}`;
const PatchIds = Schema.Record(Schema.String, Schema.String);
const decodeEntry = Schema.decodeUnknownEffect(Schema.fromJsonString(LedgerEntry));
const encodeEntry = Schema.encodeEffect(Schema.fromJsonString(LedgerEntry));
const decodePatchIds = Schema.decodeUnknownOption(Schema.fromJsonString(PatchIds));
const encodePatchIds = Schema.encodeEffect(Schema.fromJsonString(PatchIds));
/** Field separator for `git log --format`; never appears in subjects. */
const US = "\u001f";

export type SyncResult = {
  readonly range: string;
  readonly added: ReadonlyArray<{
    commit: LedgerCommit;
    thread: string;
    match: "sha" | "time";
    actions: number;
  }>;
  readonly unmatched: ReadonlyArray<LedgerCommit>;
  readonly existing: number;
};

export class Ledger extends Context.Service<
  Ledger,
  {
    /** Writes entries for commits in `range` that have none yet; `range` defaults to <default branch>..HEAD. */
    readonly sync: (
      repo: string,
      range: string | null,
      outputs: boolean,
    ) => Effect.Effect<SyncResult, LedgerFailed>;
    readonly range: (
      repo: string,
      range: string | null,
    ) => Effect.Effect<LedgerRange, LedgerFailed>;
  }
>()("toolreader/server/Ledger") {
  static readonly layer = Layer.effect(
    Ledger,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const store = yield* ThreadStore;
      const codex = yield* CodexSessions;
      const labeler = yield* Labeler;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      /** Runs git in `repo`; fails with LedgerFailed (stderr included) on a non-zero exit. */
      const git = Effect.fn("Ledger.git")(
        function* (
          repo: string,
          args: ReadonlyArray<string>,
          options: { readonly env?: Record<string, string>; readonly stdin?: string } = {},
        ) {
          const handle = yield* spawner.spawn(
            ChildProcess.make("git", ["-C", repo, ...args], {
              ...(options.env ? { env: options.env, extendEnv: true } : {}),
              ...(options.stdin !== undefined
                ? { stdin: { stream: Stream.encodeText(Stream.make(options.stdin)) } }
                : {}),
            }),
          );
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
              handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
            return yield* new LedgerFailed({
              message: `git ${args.join(" ")}: ${stderr.trim() || `exit ${exitCode}`}`,
            });
          }
          return stdout;
        },
        Effect.scoped,
        Effect.catchTag("PlatformError", (e) =>
          Effect.fail(new LedgerFailed({ message: e.message })),
        ),
      );
      const gitOption = (repo: string, args: ReadonlyArray<string>) =>
        git(repo, args).pipe(
          Effect.map((s) => s.trim()),
          Effect.option,
        );

      const defaultRange = Effect.fn("Ledger.defaultRange")(function* (repo: string) {
        const origin = yield* gitOption(repo, [
          "symbolic-ref",
          "--short",
          "refs/remotes/origin/HEAD",
        ]);
        if (Option.isSome(origin) && origin.value) return `${origin.value}..HEAD`;
        for (const branch of ["main", "master"]) {
          if (Option.isSome(yield* gitOption(repo, ["rev-parse", "--verify", "-q", branch]))) {
            return `${branch}..HEAD`;
          }
        }
        return "HEAD";
      });

      const patchId = (repo: string, sha: string) =>
        spawner
          .string(
            ChildProcess.make("git", ["-C", repo, "show", sha, "--pretty=format:"]).pipe(
              ChildProcess.pipeTo(ChildProcess.make("git", ["-C", repo, "patch-id", "--stable"])),
            ),
          )
          .pipe(
            Effect.map((s) => s.split(" ")[0]?.trim() || null),
            Effect.orElseSucceed(() => null),
          );

      const commitsIn = Effect.fn("Ledger.commitsIn")(function* (repo: string, range: string) {
        const out = yield* git(repo, ["log", "--reverse", `--format=%H${US}%s${US}%cI`, range]);
        const commits: LedgerCommit[] = [];
        for (const line of out.split("\n").filter(Boolean)) {
          const [sha = "", subject = "", committedAt = ""] = line.split(US);
          commits.push({ sha, subject, committedAt, patchId: yield* patchId(repo, sha) });
        }
        return commits;
      });

      const ledgerHead = (repo: string) =>
        gitOption(repo, ["rev-parse", "--verify", "-q", LEDGER_REF]).pipe(
          Effect.map((o) => Option.getOrNull(Option.filter(o, Boolean))),
        );

      const readPatchIds = (repo: string) =>
        gitOption(repo, ["show", `${LEDGER_REF}:patch-ids.json`]).pipe(
          Effect.map((o) =>
            Option.getOrElse(
              Option.flatMap(o, decodePatchIds),
              () => ({}) as Record<string, string>,
            ),
          ),
        );

      const readEntry = (repo: string, sha: string) =>
        gitOption(repo, ["show", `${LEDGER_REF}:${ledgerPath(sha)}`]).pipe(
          Effect.flatMap((o) =>
            Option.isSome(o)
              ? decodeEntry(o.value).pipe(
                  Effect.map(Option.some),
                  Effect.orElseSucceed(Option.none),
                )
              : Effect.succeed(Option.none<LedgerEntry>()),
          ),
        );

      /** Sessions that worked in this repo or one of its git worktrees. */
      const sessionsFor = Effect.fn("Ledger.sessionsFor")(function* (repo: string) {
        const listing = yield* git(repo, ["worktree", "list", "--porcelain"]);
        const roots = listing
          .split("\n")
          .filter((l) => l.startsWith("worktree "))
          .map((l) => l.slice("worktree ".length));
        yield* codex.ready;
        const [t3, other] = yield* Effect.all([store.list, codex.list]);
        const inRepo = (dir: string | null) =>
          !!dir && roots.some((root) => dir === root || dir.startsWith(`${root}/`));
        return [...t3, ...other].filter((t) => inRepo(t.worktree));
      });

      const sync = Effect.fn("Ledger.sync")(function* (
        repoArg: string,
        rangeArg: string | null,
        outputs: boolean,
      ) {
        const repo = (yield* git(repoArg, ["rev-parse", "--show-toplevel"])).trim();
        const range = rangeArg ?? (yield* defaultRange(repo));
        const commits = yield* commitsIn(repo, range);
        const head = yield* ledgerHead(repo);
        const existing = new Set(
          head
            ? (yield* git(repo, ["ls-tree", "-r", "--name-only", LEDGER_REF]))
                .split("\n")
                .filter((f) => f.startsWith("commits/"))
            : [],
        );
        const todo = commits.filter((c) => !existing.has(ledgerPath(c.sha)));
        if (todo.length === 0) return { range, added: [], unmatched: [], existing: commits.length };

        // Load each session that worked here once, with its commit actions.
        const sessions: Array<{
          id: string;
          entries: ReadonlyArray<Entry>;
          actions: CommitAction[];
          labels: Record<string, string>;
          thread: LedgerEntry["thread"];
        }> = [];
        for (const summary of yield* sessionsFor(repo)) {
          const labels = yield* labeler.forThread(summary.id);
          const view = yield* (
            summary.id.startsWith(CODEX_ID_PREFIX)
              ? codex.get(summary.id.slice(CODEX_ID_PREFIX.length), labels)
              : store.get(summary.id, labels)
          ).pipe(Effect.option);
          if (Option.isNone(view)) continue;
          const actions = findCommitActions(view.value.entries);
          if (actions.length === 0) continue;
          const t = view.value.thread;
          sessions.push({
            id: t.id,
            entries: view.value.entries,
            actions,
            labels: { ...view.value.labels },
            thread: {
              id: t.id,
              title: t.title,
              source: t.source,
              provider: t.provider,
              origin: t.origin,
            },
          });
        }

        const added: Array<SyncResult["added"][number]> = [];
        const unmatched: LedgerCommit[] = [];
        const writes: Array<{ commit: LedgerCommit; json: string }> = [];
        for (const commit of todo) {
          // A printed SHA anywhere wins; otherwise the latest time match across sessions.
          const candidates = sessions.flatMap((s) => {
            const m = matchCommit(commit, s.actions);
            return m ? [{ session: s, ...m }] : [];
          });
          const best =
            candidates.find((c) => c.match === "sha") ??
            candidates.sort((a, b) => (a.action.action.at < b.action.action.at ? 1 : -1))[0];
          if (!best) {
            unmatched.push(commit);
            continue;
          }
          const segment = segmentFor(best.session.entries, best.action, best.session.actions);
          const { entries, redactions } = redactEntries(segment, { outputs, home: config.home });
          const ids = new Set(entries.map((e) => e.id));
          const entry: LedgerEntry = {
            formatVersion: LEDGER_FORMAT_VERSION,
            commit,
            thread: best.session.thread,
            match: best.match,
            outputs: outputs ? "included" : "omitted",
            redactions,
            entries,
            labels: Object.fromEntries(
              Object.entries(best.session.labels).filter(
                ([id]) => ids.has(id) || id.startsWith("fold:"),
              ),
            ),
          };
          writes.push({ commit, json: yield* encodeEntry(entry).pipe(Effect.orDie) });
          added.push({
            commit,
            thread: best.session.thread.title,
            match: best.match,
            actions: entries.filter((e) => e.type === "action").length,
          });
        }
        if (writes.length > 0) yield* writeLedger(repo, head, writes, range);
        return { range, added, unmatched, existing: commits.length - todo.length };
      });

      /** Adds files to the ledger branch through a private index, then moves the ref (compare-and-swap). */
      const writeLedger = Effect.fn("Ledger.write")(
        function* (
          repo: string,
          head: string | null,
          writes: ReadonlyArray<{ commit: LedgerCommit; json: string }>,
          range: string,
        ) {
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "toolreader-ledger-" });
          const env = { GIT_INDEX_FILE: path.join(dir, "index") };
          if (head) yield* git(repo, ["read-tree", head], { env });
          const patchIds = { ...(yield* readPatchIds(repo)) };
          const add = Effect.fn("Ledger.add")(function* (file: string, content: string) {
            const blob = (yield* git(repo, ["hash-object", "-w", "--stdin"], {
              stdin: content,
            })).trim();
            yield* git(repo, ["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`], {
              env,
            });
          });
          for (const w of writes) {
            yield* add(ledgerPath(w.commit.sha), w.json);
            if (w.commit.patchId) patchIds[w.commit.patchId] = w.commit.sha;
          }
          yield* add("patch-ids.json", `${yield* encodePatchIds(patchIds).pipe(Effect.orDie)}\n`);
          const tree = (yield* git(repo, ["write-tree"], { env })).trim();
          const message = `ledger: ${writes.length} commit${writes.length === 1 ? "" : "s"} from ${range}`;
          const commit = (yield* git(repo, [
            "commit-tree",
            tree,
            ...(head ? ["-p", head] : []),
            "-m",
            message,
          ])).trim();
          yield* git(repo, ["update-ref", LEDGER_REF, commit, head ?? ""]);
        },
        Effect.scoped,
        Effect.catchTag("PlatformError", (e) =>
          Effect.fail(new LedgerFailed({ message: e.message })),
        ),
      );

      const range = Effect.fn("Ledger.range")(function* (repoArg: string, rangeArg: string | null) {
        const repo = (yield* git(repoArg, ["rev-parse", "--show-toplevel"])).trim();
        const range = rangeArg ?? (yield* defaultRange(repo));
        const commits = yield* commitsIn(repo, range);
        const patchIds = yield* readPatchIds(repo);
        const views: LedgerCommitView[] = [];
        for (const commit of commits) {
          const direct = yield* readEntry(repo, commit.sha);
          if (Option.isSome(direct)) {
            views.push({ commit, entry: direct.value, matchedBy: "sha" });
            continue;
          }
          // Rebased or amended: same diff, new SHA.
          const original = commit.patchId ? patchIds[commit.patchId] : undefined;
          const moved = original ? yield* readEntry(repo, original) : Option.none<LedgerEntry>();
          views.push({
            commit,
            entry: Option.getOrNull(moved),
            matchedBy: Option.isSome(moved) ? "patch-id" : null,
          });
        }
        const remote = yield* gitOption(repo, ["remote", "get-url", "origin"]);
        return { repo, range, remoteUrl: remoteWebUrl(Option.getOrNull(remote)), commits: views };
      });

      return Ledger.of({ sync, range });
    }),
  );
}
