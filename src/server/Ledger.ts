// The commit ledger (see src/core/ledger.ts): `sync` writes entries for agent-made commits onto the
// `agent-ledger` branch with git plumbing (never touching HEAD or the working tree), optionally on
// top of origin's copy and pushed; `range` reads them back; `hook` installs the pre-push hook.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { LedgerFailed, type ThreadNotFound } from "../core/api.ts";
import type { Entry, Labels, ThreadSummary, ThreadView } from "../core/domain.ts";
import {
  buildEntry,
  findCommitActions,
  HOOK_MARKER,
  LEDGER_BRANCH,
  LedgerEntry,
  ledgerPath,
  matchCommit,
  madeEdits,
  prePushHook,
  remoteWebUrl,
  segmentFor,
  sessionSegment,
  sessionsBetween,
  type CommitAction,
  type LedgerCommit,
  type LedgerCommitView,
  type LedgerRange,
} from "../core/ledger.ts";
import { CodexRollouts } from "./CodexRollouts.ts";
import { CODEX_ID_PREFIX, CodexSessions } from "./CodexSessions.ts";
import { Labeler } from "./Labeler.ts";
import { ServerConfig } from "./ServerConfig.ts";
import { ThreadStore } from "./ThreadStore.ts";

const LEDGER_REF = `refs/heads/${LEDGER_BRANCH}`;
const REMOTE = "origin";
const REMOTE_REF = `refs/remotes/${REMOTE}/${LEDGER_BRANCH}`;
/** Pushes that lose a race refetch and retry this many times in total. */
const PUSH_ATTEMPTS = 5;
/** git's words for a push that lost a race: behind the remote, or the remote ref moved mid-push. */
const LOST_RACE = /\[rejected\]|non-fast-forward|fetch first|incorrect old value|cannot lock ref/;
const PatchIds = Schema.Record(Schema.String, Schema.String);
const decodeEntry = Schema.decodeUnknownEffect(Schema.fromJsonString(LedgerEntry));
const encodeEntry = Schema.encodeEffect(Schema.fromJsonString(LedgerEntry));
const decodePatchIds = Schema.decodeUnknownOption(Schema.fromJsonString(PatchIds));
const encodePatchIds = Schema.encodeEffect(Schema.fromJsonString(PatchIds));
/** Field separator for `git log --format`; never appears in subjects. */
const US = "\u001f";

/** Where sessions come from. `auto`: T3 if its database exists, plus Codex rollout files. */
export const LEDGER_SOURCES = ["auto", "t3", "codex-app-server", "codex-rollouts"] as const;
export type LedgerSource = (typeof LEDGER_SOURCES)[number];

export type SyncOptions = {
  /** Keep command and tool outputs (redacted). */
  readonly outputs: boolean;
  /** Bytes kept per output, head and tail; 0 keeps them whole. */
  readonly maxOutput: number;
  readonly source: LedgerSource;
  /** Write on top of origin's agent-ledger and push it, retrying when another push wins. */
  readonly push: boolean;
  /**
   * For commits no `git commit` action made: tie each to the session in this worktree that made
   * edits and ended between the previous commit and it. Several such sessions: none is attached.
   * Only safe where every session is this job's own (CI with a job-local CODEX_HOME).
   */
  readonly matchSessions: boolean;
  /** Sessions (ids, `codex:` optional) to tie such commits to, instead of guessing which. */
  readonly sessions: ReadonlyArray<string>;
};
export const SYNC_DEFAULTS: SyncOptions = {
  outputs: true,
  maxOutput: 8192,
  source: "auto",
  push: false,
  matchSessions: false,
  sessions: [],
};

export type SyncResult = {
  readonly range: string;
  readonly sources: ReadonlyArray<string>;
  readonly added: ReadonlyArray<{
    commit: LedgerCommit;
    thread: string;
    match: LedgerEntry["match"];
    actions: number;
  }>;
  readonly unmatched: ReadonlyArray<LedgerCommit>;
  /** Commits several sessions could have produced: left without an entry rather than guessed. */
  readonly ambiguous: ReadonlyArray<{ commit: LedgerCommit; sessions: ReadonlyArray<string> }>;
  readonly existing: number;
  /** The ledger commit now on origin, when `push` sent one. */
  readonly pushed: string | null;
};

type Session = {
  /** Worked in the synced worktree itself, not another worktree of the repo. */
  readonly here: boolean;
  readonly edited: boolean;
  readonly entries: ReadonlyArray<Entry>;
  readonly actions: CommitAction[];
  readonly labels: Labels;
  readonly thread: LedgerEntry["thread"];
};
type Write = { readonly commit: LedgerCommit; readonly json: string };

export class Ledger extends Context.Service<
  Ledger,
  {
    /** Writes entries for commits in `range` that have none yet; `range` defaults to <default branch>..HEAD. */
    readonly sync: (
      repo: string,
      range: string | null,
      options?: Partial<SyncOptions>,
    ) => Effect.Effect<SyncResult, LedgerFailed>;
    readonly range: (
      repo: string,
      range: string | null,
    ) => Effect.Effect<LedgerRange, LedgerFailed>;
    /** Installs or removes the pre-push hook that runs `<command> sync … --push`; returns what it did. */
    readonly hook: (
      repo: string,
      action: "install" | "uninstall",
      command: string,
    ) => Effect.Effect<string, LedgerFailed>;
  }
>()("toolreader/server/Ledger") {
  static readonly layer = Layer.effect(
    Ledger,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const store = yield* ThreadStore;
      const codex = yield* CodexSessions;
      const rollouts = yield* CodexRollouts;
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
      const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));

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

      /**
       * Commits of a range, oldest first, with each one's parent commit time. A range is what
       * `git log` takes: `A..B`, or several words such as `B --not --remotes=origin`.
       */
      const commitsIn = Effect.fn("Ledger.commitsIn")(function* (repo: string, range: string) {
        const out = yield* git(repo, [
          "log",
          "--reverse",
          `--format=%H${US}%s${US}%cI${US}%P`,
          ...range.split(/\s+/).filter(Boolean),
        ]);
        const commits: LedgerCommit[] = [];
        const parents = new Map<string, string | undefined>();
        for (const line of out.split("\n").filter(Boolean)) {
          const [sha = "", subject = "", committedAt = "", parentList = ""] = line.split(US);
          commits.push({ sha, subject, committedAt, patchId: yield* patchId(repo, sha) });
          parents.set(sha, parentList.split(" ")[0] || undefined);
        }
        const times = new Map(commits.map((c) => [c.sha, c.committedAt]));
        const previousAt = new Map<string, string | null>();
        for (const c of commits) {
          const parent = parents.get(c.sha);
          previousAt.set(
            c.sha,
            !parent
              ? null
              : (times.get(parent) ??
                  Option.getOrNull(yield* gitOption(repo, ["log", "-1", "--format=%cI", parent]))),
          );
        }
        return { commits, previousAt };
      });

      const resolve = (repo: string, ref: string) =>
        gitOption(repo, ["rev-parse", "--verify", "-q", ref]).pipe(
          Effect.map((o) => Option.getOrNull(Option.filter(o, Boolean))),
        );
      const filesIn = (repo: string, commit: string | null) =>
        commit
          ? git(repo, ["ls-tree", "-r", "--name-only", commit]).pipe(
              Effect.map((out) => new Set(out.split("\n").filter(Boolean))),
            )
          : Effect.succeed(new Set<string>());

      const readPatchIds = (repo: string, commit: string) =>
        gitOption(repo, ["show", `${commit}:patch-ids.json`]).pipe(
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

      /** Sessions from the chosen sources that worked in this repo or one of its git worktrees. */
      const sessionsFor = Effect.fn("Ledger.sessionsFor")(function* (
        repo: string,
        source: LedgerSource,
      ) {
        const listing = yield* git(repo, ["worktree", "list", "--porcelain"]);
        const roots = listing
          .split("\n")
          .filter((l) => l.startsWith("worktree "))
          .map((l) => l.slice("worktree ".length));
        const hasT3 = yield* exists(config.dbPath);
        const hasRollouts = yield* exists(path.join(config.codexHome, "sessions"));
        if (source === "t3" && !hasT3)
          return yield* new LedgerFailed({ message: `No T3 database at ${config.dbPath}` });
        if (source === "codex-rollouts" && !hasRollouts)
          return yield* new LedgerFailed({
            message: `No Codex sessions in ${path.join(config.codexHome, "sessions")}`,
          });

        const sources: string[] = [];
        const found: Array<{
          summary: ThreadSummary;
          load: (labels: Labels) => Effect.Effect<ThreadView, ThreadNotFound>;
        }> = [];
        const bare = (s: ThreadSummary) => s.id.slice(CODEX_ID_PREFIX.length);
        if (source === "t3" || (source === "auto" && hasT3)) {
          sources.push("t3");
          for (const s of yield* store.list)
            found.push({ summary: s, load: (l) => store.get(s.id, l) });
        }
        if (source === "codex-app-server") {
          sources.push("codex-app-server");
          yield* codex.ready;
          for (const s of yield* codex.list)
            found.push({ summary: s, load: (l) => codex.get(bare(s), l) });
        }
        // T3 runs Codex too; the rollout listing skips the sessions T3 owns.
        if (source === "codex-rollouts" || (source === "auto" && hasRollouts)) {
          sources.push("codex-rollouts");
          for (const s of yield* rollouts.list)
            found.push({ summary: s, load: (l) => rollouts.get(bare(s), l) });
        }
        // The innermost worktree holding the session's directory (worktrees can nest).
        const rootOf = (dir: string | null) =>
          roots
            .filter((root) => !!dir && (dir === root || dir.startsWith(`${root}/`)))
            .sort((a, b) => b.length - a.length)[0];
        return {
          sources,
          found: found.flatMap((f) => {
            const root = rootOf(f.summary.worktree);
            return root ? [{ ...f, root }] : [];
          }),
        };
      });

      /**
       * A ledger commit with `bases` as parents (their files merged, patch-ids united) plus
       * `writes`, built through a private index. Moves no ref.
       */
      const writeTree = Effect.fn("Ledger.writeTree")(
        function* (
          repo: string,
          bases: ReadonlyArray<string>,
          writes: ReadonlyArray<Write>,
          message: string,
        ) {
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "toolreader-ledger-" });
          const env = { GIT_INDEX_FILE: path.join(dir, "index") };
          const [first, ...others] = bases;
          if (first) yield* git(repo, ["read-tree", first], { env });
          const have = yield* git(repo, ["ls-files"], { env }).pipe(
            Effect.map((out) => new Set(out.split("\n").filter(Boolean))),
          );
          const patchIds: Record<string, string> = {};
          for (const base of bases) Object.assign(patchIds, yield* readPatchIds(repo, base));
          // Entries only one side has (e.g. synced here but never pushed) are kept.
          for (const base of others) {
            const missing = (yield* git(repo, ["ls-tree", "-r", base]))
              .split("\n")
              .filter((l) => l && !have.has(l.slice(l.indexOf("\t") + 1)));
            if (missing.length > 0)
              yield* git(repo, ["update-index", "--index-info"], {
                env,
                stdin: `${missing.join("\n")}\n`,
              });
          }
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
          return (yield* git(repo, [
            "commit-tree",
            tree,
            ...bases.flatMap((b) => ["-p", b]),
            "-m",
            message,
          ])).trim();
        },
        Effect.scoped,
        Effect.catchTag("PlatformError", (e) =>
          Effect.fail(new LedgerFailed({ message: e.message })),
        ),
      );

      /** origin's agent-ledger tip after fetching it into refs/remotes, or null if it has none. */
      const fetchRemote = Effect.fn("Ledger.fetchRemote")(function* (repo: string) {
        const advertised = yield* git(repo, ["ls-remote", REMOTE, LEDGER_REF]);
        if (!advertised.trim()) return null;
        yield* git(repo, ["fetch", "--quiet", "--no-tags", REMOTE, `+${LEDGER_REF}:${REMOTE_REF}`]);
        return yield* resolve(repo, REMOTE_REF);
      });

      /** Commits among `refs` that none of the others contain, in the given order. */
      const independent = Effect.fn("Ledger.independent")(function* (
        repo: string,
        refs: ReadonlyArray<string | null>,
      ) {
        const unique = [...new Set(refs.filter((r): r is string => !!r))];
        if (unique.length < 2) return unique;
        const keep = new Set(
          (yield* git(repo, ["merge-base", "--independent", ...unique])).split("\n"),
        );
        return unique.filter((r) => keep.has(r));
      });

      /**
       * Writes `writes` on top of origin's agent-ledger (and any local-only history), pushes,
       * and only then moves the local branch. A push that loses a race refetches and rebuilds.
       */
      const publish = Effect.fn("Ledger.publish")(function* (
        repo: string,
        writes: ReadonlyArray<Write>,
        message: string,
      ) {
        for (let attempt = 1; ; attempt++) {
          const remote = yield* fetchRemote(repo);
          const local = yield* resolve(repo, LEDGER_REF);
          const bases = yield* independent(repo, [remote, local]);
          const onRemote = yield* filesIn(repo, remote);
          // Another job may have recorded the same commit meanwhile; its entry stays.
          const fresh = writes.filter((w) => !onRemote.has(ledgerPath(w.commit.sha)));
          const head =
            fresh.length === 0 && bases.length === 1
              ? bases[0]!
              : yield* writeTree(repo, bases, fresh, message);
          let pushed: string | null = null;
          if (head !== remote) {
            const result = yield* git(repo, [
              "push",
              "--quiet",
              "--no-verify",
              REMOTE,
              `${head}:${LEDGER_REF}`,
            ]).pipe(Effect.result);
            if (result._tag === "Failure") {
              if (attempt < PUSH_ATTEMPTS && LOST_RACE.test(result.failure.message)) continue;
              return yield* result.failure;
            }
            pushed = head;
          }
          if (head !== local) yield* git(repo, ["update-ref", LEDGER_REF, head, local ?? ""]);
          return pushed;
        }
      });

      /**
       * Sync moves agent-ledger with `update-ref`; under a worktree that has it checked out, that
       * would move its HEAD and leave its index and files behind. So such a worktree stops sync.
       */
      const ensureNotCheckedOut = Effect.fn("Ledger.ensureNotCheckedOut")(function* (repo: string) {
        const listing = yield* git(repo, ["worktree", "list", "--porcelain"]);
        const holder = listing
          .split("\n\n")
          .map((block) => block.split("\n"))
          .find((lines) => lines.includes(`branch ${LEDGER_REF}`));
        if (holder)
          return yield* new LedgerFailed({
            message: `${LEDGER_BRANCH} is checked out in ${holder[0]?.slice("worktree ".length)}; switch that worktree to another branch before syncing.`,
          });
      });

      const sync = Effect.fn("Ledger.sync")(function* (
        repoArg: string,
        rangeArg: string | null,
        partial: Partial<SyncOptions> = {},
      ) {
        const options = { ...SYNC_DEFAULTS, ...partial };
        const repo = (yield* git(repoArg, ["rev-parse", "--show-toplevel"])).trim();
        yield* ensureNotCheckedOut(repo);
        const range = rangeArg ?? (yield* defaultRange(repo));
        const { commits, previousAt } = yield* commitsIn(repo, range);
        const remote = options.push ? yield* fetchRemote(repo) : null;
        const existing = new Set([
          ...(yield* filesIn(repo, yield* resolve(repo, LEDGER_REF))),
          ...(yield* filesIn(repo, remote)),
        ]);
        const todo = commits.filter((c) => !existing.has(ledgerPath(c.sha)));
        const { sources, found } = yield* sessionsFor(repo, options.source);

        // Load each session that worked here once.
        const sessions: Session[] = [];
        if (todo.length > 0) {
          for (const { summary, load, root } of found) {
            const labels = yield* labeler.forThread(summary.id);
            const view = yield* load(labels).pipe(Effect.option);
            if (Option.isNone(view)) continue;
            const { entries, thread: t } = view.value;
            if (!entries.some((e) => e.type === "action")) continue;
            sessions.push({
              here: root === repo,
              edited: madeEdits(entries),
              entries,
              actions: findCommitActions(entries),
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
        }

        // Who may take a commit no `git commit` action made: the sessions named, or (when asked)
        // the ones that edited this worktree.
        const isNamed = (s: Session, name: string) =>
          s.thread.id === name || s.thread.id === `${CODEX_ID_PREFIX}${name}`;
        const missing = options.sessions.filter((name) => !sessions.some((s) => isNamed(s, name)));
        if (todo.length > 0 && missing.length > 0)
          return yield* new LedgerFailed({
            message: `No session ${missing.join(", ")} in ${sources.join(" + ") || "any source"} for ${repo}`,
          });
        const eligible =
          options.sessions.length > 0
            ? sessions.filter((s) => options.sessions.some((name) => isNamed(s, name)))
            : options.matchSessions
              ? sessions.filter((s) => s.here && s.edited)
              : [];

        const added: Array<SyncResult["added"][number]> = [];
        const unmatched: LedgerCommit[] = [];
        const ambiguous: Array<SyncResult["ambiguous"][number]> = [];
        const writes: Write[] = [];
        for (const commit of todo) {
          // A printed SHA anywhere wins; then the latest time match; then the one eligible session
          // that ended between the previous commit and this one.
          const candidates = sessions.flatMap((s) => {
            const m = matchCommit(commit, s.actions);
            return m ? [{ session: s, ...m }] : [];
          });
          const best =
            candidates.find((c) => c.match === "sha") ??
            candidates.sort((a, b) => (a.action.action.at < b.action.action.at ? 1 : -1))[0];
          const before = previousAt.get(commit.sha) ?? null;
          const between = best ? [] : sessionsBetween(commit, before, eligible);
          if (between.length > 1) {
            ambiguous.push({ commit, sessions: between.map((s) => s.thread.id) });
            continue;
          }
          const fallback = between[0];
          const picked = best
            ? {
                session: best.session,
                match: best.match,
                segment: segmentFor(best.session.entries, best.action, best.session.actions),
              }
            : fallback
              ? {
                  session: fallback,
                  match: "session" as const,
                  segment: sessionSegment(fallback.entries, fallback.actions, before),
                }
              : null;
          if (!picked || !picked.segment.some((e) => e.type === "action")) {
            unmatched.push(commit);
            continue;
          }
          const entry = buildEntry({
            commit,
            thread: picked.session.thread,
            match: picked.match,
            segment: picked.segment,
            labels: picked.session.labels,
            outputs: options.outputs,
            maxOutput: options.maxOutput,
            home: config.home,
          });
          writes.push({ commit, json: yield* encodeEntry(entry).pipe(Effect.orDie) });
          added.push({
            commit,
            thread: entry.thread.title,
            match: picked.match,
            actions: entry.entries.filter((e) => e.type === "action").length,
          });
        }

        const message = `ledger: ${writes.length} commit${writes.length === 1 ? "" : "s"} from ${range}`;
        let pushed: string | null = null;
        if (options.push) {
          pushed = yield* publish(repo, writes, message);
        } else if (writes.length > 0) {
          const local = yield* resolve(repo, LEDGER_REF);
          const head = yield* writeTree(repo, local ? [local] : [], writes, message);
          yield* git(repo, ["update-ref", LEDGER_REF, head, local ?? ""]);
        }
        return {
          range,
          sources,
          added,
          unmatched,
          ambiguous,
          existing: commits.length - todo.length,
          pushed,
        };
      });

      const range = Effect.fn("Ledger.range")(function* (repoArg: string, rangeArg: string | null) {
        const repo = (yield* git(repoArg, ["rev-parse", "--show-toplevel"])).trim();
        const range = rangeArg ?? (yield* defaultRange(repo));
        const { commits } = yield* commitsIn(repo, range);
        const head = yield* resolve(repo, LEDGER_REF);
        const patchIds = head ? yield* readPatchIds(repo, head) : {};
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

      const hook = Effect.fn("Ledger.hook")(
        function* (repo: string, action: "install" | "uninstall", command: string) {
          const file = path.resolve(
            repo,
            (yield* git(repo, ["rev-parse", "--git-path", "hooks/pre-push"])).trim(),
          );
          const current = (yield* exists(file)) ? yield* fs.readFileString(file) : null;
          const ours = current?.includes(HOOK_MARKER) ?? false;
          const script = prePushHook(command);
          if (action === "uninstall") {
            if (current === null) return `No pre-push hook at ${file}.`;
            if (!ours)
              return yield* new LedgerFailed({
                message: `${file} is not toolreader's hook; leaving it alone.`,
              });
            yield* fs.remove(file);
            return `Removed ${file}.`;
          }
          if (current !== null && !ours)
            return yield* new LedgerFailed({
              message: [
                `${file} already exists and is not toolreader's; leaving it alone.`,
                "To chain the ledger, add this to it (it reads the same stdin):",
                script.slice(script.indexOf('[ "$1"'), script.lastIndexOf("exit 0")).trimEnd(),
              ].join("\n"),
            });
          if (current === script) return `Already installed: ${file}.`;
          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
          yield* fs.writeFileString(file, script);
          yield* fs.chmod(file, 0o755);
          return `${current === null ? "Installed" : "Updated"} ${file}.`;
        },
        Effect.catchTag("PlatformError", (e) =>
          Effect.fail(new LedgerFailed({ message: e.message })),
        ),
      );

      return Ledger.of({ sync, range, hook });
    }),
  );
}
