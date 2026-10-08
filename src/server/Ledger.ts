// The commit ledger (see src/core/ledger.ts): `sync` writes entries for agent-made commits onto the
// `agent-ledger` branch with git plumbing (never touching HEAD or the working tree), optionally on
// top of origin's copy and pushed; `range` reads them back; `hook` installs the pre-push hook.
// Every entry is written as Sanitizer.ts leaves it; `sanitize` rewrites the whole branch that way.
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
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
  commitMsgHook,
  editedPaths,
  fileCoverage,
  findCommitActions,
  HOOK_MARKER,
  LEDGER_BRANCH,
  LedgerEntry,
  ledgerPath,
  matchCommit,
  madeEdits,
  mergeEntries,
  nativeId,
  prePushHook,
  remoteWebUrl,
  segmentByTime,
  segmentFor,
  SESSION_TRAILER,
  sessionSegment,
  sessionsBetween,
  strongerVia,
  type CommitAction,
  type FoundLink,
  type LedgerCommit,
  type LedgerCommitView,
  type LedgerLink,
  type LedgerRange,
  type LedgerThread,
  type LinkRole,
  type LinkVia,
} from "../core/ledger.ts";
import { ledgerSiteHtml, publicRange } from "../core/ledgerSite.ts";
import type { SanitizeMode } from "../core/sanitize.ts";
import { CodexRollouts, ROLLOUT_DIRS } from "./CodexRollouts.ts";
import { CODEX_ID_PREFIX, CodexSessions } from "./CodexSessions.ts";
import { Labeler } from "./Labeler.ts";
import { Sanitizer, type SanitizeChoice } from "./Sanitizer.ts";
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
const sameEntry = (a: LedgerEntry, b: LedgerEntry) => JSON.stringify(a) === JSON.stringify(b);
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
  /** How entries are sanitized; null: the repo's `.toolreader.json`, else `anonymize`. */
  readonly sanitize: SanitizeMode | "off" | null;
  /** Run the agent pass; null: the repo's `.toolreader.json`, else no. */
  readonly sanitizeAgent: boolean | null;
};
export const SYNC_DEFAULTS: SyncOptions = {
  outputs: true,
  maxOutput: 8192,
  source: "auto",
  push: false,
  matchSessions: false,
  sessions: [],
  sanitize: null,
  sanitizeAgent: null,
};

export type SyncResult = {
  readonly range: string;
  readonly sources: ReadonlyArray<string>;
  /** Threads newly linked to a commit. */
  readonly added: ReadonlyArray<{
    commit: LedgerCommit;
    links: ReadonlyArray<{ title: string; role: LinkRole; via: LinkVia; actions: number }>;
  }>;
  /** Commits with no thread: recorded with every file untracked. */
  readonly unmatched: ReadonlyArray<LedgerCommit>;
  /** Commits several sessions could have produced: left without an entry rather than guessed. */
  readonly ambiguous: ReadonlyArray<{ commit: LedgerCommit; sessions: ReadonlyArray<string> }>;
  readonly existing: number;
  /** The ledger commit now on origin, when `push` sent one. */
  readonly pushed: string | null;
  readonly sanitized: SanitizeSummary;
};

export type SanitizeSummary = {
  readonly mode: SanitizeMode | "off";
  readonly hits: number;
  /** Spans the agent pass named, when it ran. */
  readonly spans: number | null;
};

export type SanitizeBranchResult = SanitizeSummary & {
  readonly entries: number;
  /** The new agent-ledger commit: one commit, no history. */
  readonly head: string | null;
  readonly pushed: string | null;
};

type Session = {
  /** Worked in the synced worktree itself, not another worktree of the repo. */
  readonly here: boolean;
  /** The worktree it worked in. */
  readonly root: string;
  readonly edited: boolean;
  readonly entries: ReadonlyArray<Entry>;
  readonly actions: CommitAction[];
  readonly labels: Labels;
  readonly thread: LedgerThread;
};
type Write = { readonly commit: LedgerCommit; readonly entry: LedgerEntry };

/** What `ledger link`, `unlink`, `note` and `review` change on one commit's entry. */
export type Assertion =
  | {
      readonly link: {
        readonly session: string;
        readonly role: LinkRole;
        /** Reviewers: the commit reviewed (the commit itself by default). */
        readonly reviewed?: boolean;
      };
    }
  | { readonly unlink: string }
  | { readonly note: { readonly text: string; readonly file: string | null } };

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
    /** Writes the static page of a range (`ledger site`, `publicRange`) to `<out>/index.html`. */
    readonly site: (
      repo: string,
      range: string | null,
      out: string,
    ) => Effect.Effect<{ readonly file: string; readonly view: LedgerRange }, LedgerFailed>;
    /**
     * Rewrites agent-ledger (local and, with `push`, origin's) as one commit of its entries
     * sanitized, so no earlier version stays in its history. A push only replaces the origin
     * commit it read.
     */
    readonly sanitize: (
      repo: string,
      choice: SanitizeChoice & { readonly push: boolean },
    ) => Effect.Effect<SanitizeBranchResult, LedgerFailed>;
    /**
     * Installs or removes the pre-push hook that runs `<command> sync … --push` and, with
     * `commit`, the hook that adds an `Agent-Session` trailer; returns what it did.
     */
    readonly hook: (
      repo: string,
      action: "install" | "uninstall",
      command: string,
      options?: { readonly commit?: boolean },
    ) => Effect.Effect<string, LedgerFailed>;
    /** Links or unlinks a thread, or adds a note, on one commit's entry (local agent-ledger only). */
    readonly assert: (
      repo: string,
      sha: string,
      change: Assertion,
    ) => Effect.Effect<
      { readonly entry: LedgerEntry; readonly linked: LedgerLink | null },
      LedgerFailed
    >;
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
      const sanitizer = yield* Sanitizer;
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
          `--format=%H${US}%s${US}%cI${US}%P${US}%(trailers:key=${SESSION_TRAILER},valueonly,separator=%x1e)`,
          ...range.split(/\s+/).filter(Boolean),
        ]);
        const commits: LedgerCommit[] = [];
        const parents = new Map<string, string | undefined>();
        const trailers = new Map<string, string[]>();
        const paths = new Map<string, string[]>();
        for (const line of out.split("\n").filter(Boolean)) {
          const [sha = "", subject = "", committedAt = "", parentList = "", sessions = ""] =
            line.split(US);
          commits.push({ sha, subject, committedAt, patchId: yield* patchId(repo, sha) });
          parents.set(sha, parentList.split(" ")[0] || undefined);
          trailers.set(sha, sessions.split("\u001e").filter(Boolean));
          // A merge's diff is its whole branch, whose own commits carry their threads.
          paths.set(sha, parentList.includes(" ") ? [] : yield* changedPaths(repo, sha));
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
        return { commits, previousAt, trailers, paths };
      });

      /** Files a commit changed (against its first parent). */
      const changedPaths = (repo: string, sha: string) =>
        // Unquoted, so a path with non-ASCII characters reads as itself.
        git(repo, [
          "-c",
          "core.quotePath=false",
          "log",
          "-1",
          "-m",
          "--first-parent",
          "--format=",
          "--name-only",
          sha,
        ]).pipe(Effect.map((out) => out.split("\n").filter(Boolean)));

      /** Each file of a ledger commit's tree, with its blob. */
      const blobsIn = (repo: string, commit: string) =>
        git(repo, ["ls-tree", "-r", commit]).pipe(
          Effect.map(
            (out) =>
              new Map(
                out
                  .split("\n")
                  .filter(Boolean)
                  .map((l) => [l.slice(l.indexOf("\t") + 1), l.split(/\s/)[2]] as const),
              ),
          ),
        );

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

      /**
       * The entry for `sha` on `ref`. One that doesn't decode (a newer toolreader wrote it) fails:
       * read as missing, a write would replace it and lose its links.
       */
      const readEntry = (repo: string, sha: string, ref: string = LEDGER_REF) =>
        gitOption(repo, ["show", `${ref}:${ledgerPath(sha)}`]).pipe(
          Effect.flatMap((o) =>
            Option.isSome(o)
              ? decodeEntry(o.value).pipe(
                  Effect.map(Option.some),
                  Effect.mapError(
                    (e) =>
                      new LedgerFailed({
                        message: `${ref}:${ledgerPath(sha)} doesn't read (written by a newer toolreader?): ${e.message}`,
                      }),
                  ),
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
        const rolloutDirs = ROLLOUT_DIRS.map((dir) => path.join(config.codexHome, dir));
        const hasRollouts = (yield* Effect.forEach(rolloutDirs, exists)).some(Boolean);
        if (source === "t3" && !hasT3)
          return yield* new LedgerFailed({ message: `No T3 database at ${config.dbPath}` });
        if (source === "codex-rollouts" && !hasRollouts)
          return yield* new LedgerFailed({
            message: `No Codex sessions in ${rolloutDirs.join(" or ")}`,
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
            yield* add(ledgerPath(w.commit.sha), yield* encodeEntry(w.entry).pipe(Effect.orDie));
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
          // Diverged (another job pushed, or the local branch began on its own): the tree starts as
          // origin's, so local entries that differ from origin's (`ledger link`, `note`) join ours.
          const pending = new Map(writes.map((w) => [w.commit.sha, w]));
          // The local branch may have moved since sync read it (a `ledger note` meanwhile).
          if (local)
            for (const w of writes) {
              const mine = Option.getOrNull(yield* readEntry(repo, w.commit.sha, local));
              if (mine) pending.set(w.commit.sha, { ...w, entry: mergeEntries(mine, w.entry) });
            }
          if (remote && local && bases.length === 2) {
            const [theirs, ours] = [yield* blobsIn(repo, remote), yield* blobsIn(repo, local)];
            for (const [file, blob] of ours) {
              if (!file.startsWith("commits/") || !theirs.has(file) || theirs.get(file) === blob)
                continue;
              const entry = Option.getOrNull(
                yield* readEntry(repo, file.slice("commits/".length, -".json".length), local),
              );
              if (!entry) continue;
              const w = pending.get(entry.commit.sha);
              pending.set(entry.commit.sha, {
                commit: entry.commit,
                entry: w ? mergeEntries(entry, w.entry) : entry,
              });
            }
          }
          // Another job may have recorded the same commit meanwhile: its links stay, ours join them.
          const fresh: Write[] = [];
          for (const w of pending.values()) {
            const theirs =
              remote && onRemote.has(ledgerPath(w.commit.sha))
                ? Option.getOrNull(yield* readEntry(repo, w.commit.sha, remote))
                : null;
            if (!theirs) {
              fresh.push(w);
              continue;
            }
            const merged = mergeEntries(theirs, w.entry);
            if (!sameEntry(merged, theirs)) fresh.push({ commit: w.commit, entry: merged });
          }
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

      /** Each session that worked here, loaded once, with its subagent parent from T3. */
      const loadSessions = Effect.fn("Ledger.loadSessions")(function* (
        repo: string,
        source: LedgerSource,
      ) {
        const { sources, found } = yield* sessionsFor(repo, source);
        const { nativeIds, parents } = yield* store.lineage;
        const sessions: Session[] = [];
        for (const { summary, load, root } of found) {
          const labels = yield* labeler.forThread(summary.id);
          const view = yield* load(labels).pipe(Effect.option);
          if (Option.isNone(view)) continue;
          const { entries, thread: t } = view.value;
          if (!entries.some((e) => e.type === "action")) continue;
          sessions.push({
            here: root === repo,
            root,
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
              parent: parents.get(t.id) ?? null,
            },
          });
        }
        // A name is a thread id, `codex:<id>`, or what an agent exports (`claude-code:<id>`),
        // which T3 knows by its provider thread.
        const named = (name: string) => {
          const id = nativeId(name);
          const ids = new Set([name, id, `${CODEX_ID_PREFIX}${id}`, nativeIds.get(id)]);
          return sessions.filter((s) => ids.has(s.thread.id));
        };
        return { sources, sessions, named };
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
        const { commits, previousAt, trailers, paths } = yield* commitsIn(repo, range);
        const remote = options.push ? yield* fetchRemote(repo) : null;
        const local = yield* resolve(repo, LEDGER_REF);
        const { sources, sessions, named } =
          commits.length > 0
            ? yield* loadSessions(repo, options.source)
            : { sources: [], sessions: [], named: () => [] };

        // Who may take a commit no `git commit` action made: the sessions named, or (when asked)
        // the ones that edited this worktree.
        const missing = options.sessions.filter((name) => named(name).length === 0);
        if (commits.length > 0 && missing.length > 0)
          return yield* new LedgerFailed({
            message: `No session ${missing.join(", ")} in ${sources.join(" + ") || "any source"} for ${repo}`,
          });
        const eligible =
          options.sessions.length > 0
            ? [...new Set(options.sessions.flatMap(named))]
            : options.matchSessions
              ? sessions.filter((s) => s.here && s.edited)
              : [];

        const added: Array<SyncResult["added"][number]> = [];
        const unmatched: LedgerCommit[] = [];
        const ambiguous: Array<SyncResult["ambiguous"][number]> = [];
        const built: Array<{
          commit: LedgerCommit;
          entry: LedgerEntry;
          current: LedgerEntry | null;
        }> = [];
        let existing = 0;
        for (const commit of commits) {
          const before = previousAt.get(commit.sha) ?? null;
          const files = paths.get(commit.sha) ?? [];
          const current =
            Option.getOrNull(yield* readEntry(repo, commit.sha)) ??
            (remote ? Option.getOrNull(yield* readEntry(repo, commit.sha, remote)) : null);
          const found: FoundLink[] = [];
          // Strongest first; a thread found again keeps its first (strongest) link.
          const add = (s: Session, via: LinkVia, segment: ReadonlyArray<Entry>) => {
            // A trailer names the thread even when its history here shows no action.
            if (via !== "trailer" && !segment.some((e) => e.type === "action")) return;
            if (found.some((f) => f.thread.id === s.thread.id)) return;
            found.push({
              thread: s.thread,
              role: "coder",
              via,
              reviewedSha: null,
              segment,
              labels: s.labels,
              root: s.root,
            });
          };
          // A trailer's thread: everything since the commit's parent (an amend or an earlier
          // `git commit` of the same change must not cut its history short).
          for (const name of trailers.get(commit.sha) ?? [])
            for (const s of named(name))
              add(s, "trailer", segmentByTime(s.entries, before, commit.committedAt));
          // A printed SHA, in any session; else the latest `git commit` action just before it.
          const candidates = sessions.flatMap((s) => {
            const m = matchCommit(commit, s.actions);
            return m ? [{ session: s, ...m }] : [];
          });
          for (const c of candidates.filter((c) => c.match === "sha"))
            add(c.session, "sha", segmentFor(c.session.entries, c.action, c.session.actions));
          const byTime = candidates
            .filter((c) => c.match === "time")
            .sort((a, b) => (a.action.action.at < b.action.action.at ? 1 : -1))[0];
          if (byTime && found.length === 0)
            add(
              byTime.session,
              "time",
              segmentFor(byTime.session.entries, byTime.action, byTime.session.actions),
            );
          if (found.length === 0 && eligible.length > 0) {
            const between = sessionsBetween(commit, before, eligible);
            if (between.length > 1) {
              ambiguous.push({ commit, sessions: between.map((s) => s.thread.id) });
              continue;
            }
            const s = between[0];
            if (s) add(s, "session", sessionSegment(s.entries, s.actions, before));
          }
          // Every other thread that edited the commit's files in this worktree since the
          // previous commit (another worktree's edits never reach this commit).
          for (const s of sessions.filter((s) => s.here)) {
            const segment = segmentByTime(s.entries, before, commit.committedAt);
            if (editedPaths(segment, files).size > 0) add(s, "evidence", segment);
          }

          // Only what the entry doesn't already hold as strongly (or holds with less history),
          // nor had unlinked.
          const fresh = found.filter((f) => {
            if (current?.unlinked.includes(f.thread.id)) return false;
            const old = current?.links.find(
              (l) => l.thread.id === f.thread.id && l.role === f.role,
            );
            if (!old || old.entries.length === 0 || strongerVia(f.via, old.via)) return true;
            if (strongerVia(old.via, f.via)) return false;
            const have = new Set(old.entries.map((e) => e.id));
            return f.segment.some((e) => !have.has(e.id));
          });
          if (current && fresh.length === 0) {
            existing++;
            continue;
          }
          if (!current && found.length === 0) unmatched.push(commit);
          built.push({
            commit,
            current,
            entry: buildEntry({
              commit,
              links: fresh,
              paths: files,
              outputs: options.outputs,
              maxOutput: options.maxOutput,
              home: config.home,
            }),
          });
        }

        const sanitized = yield* sanitizeAll(
          repo,
          built.map((b) => b.entry),
          { mode: options.sanitize, agent: options.sanitizeAgent },
        );
        const writes: Write[] = [];
        for (const [i, { commit, current }] of built.entries()) {
          const fresh = sanitized.entries[i]!;
          const entry = current ? mergeEntries(current, fresh) : fresh;
          if (current && sameEntry(entry, current)) {
            existing++;
            continue;
          }
          writes.push({ commit, entry });
          if (fresh.links.length > 0)
            added.push({
              commit,
              links: fresh.links.map((l) => ({
                title: l.thread.title,
                role: l.role,
                via: l.via,
                actions: l.entries.filter((e) => e.type === "action").length,
              })),
            });
        }

        const message = `ledger: ${writes.length} commit${writes.length === 1 ? "" : "s"} from ${range}`;
        let pushed: string | null = null;
        if (options.push) {
          pushed = yield* publish(repo, writes, message);
        } else if (writes.length > 0) {
          const head = yield* writeTree(repo, local ? [local] : [], writes, message);
          yield* git(repo, ["update-ref", LEDGER_REF, head, local ?? ""]);
        }
        return {
          range,
          sources,
          added,
          unmatched,
          ambiguous,
          existing,
          pushed,
          sanitized: summary(sanitized),
        };
      });

      const assert = Effect.fn("Ledger.assert")(function* (
        repoArg: string,
        rev: string,
        change: Assertion,
      ) {
        const repo = (yield* git(repoArg, ["rev-parse", "--show-toplevel"])).trim();
        yield* ensureNotCheckedOut(repo);
        const sha = yield* resolve(repo, `${rev}^{commit}`);
        if (!sha) return yield* new LedgerFailed({ message: `No commit ${rev}` });
        const { commits, previousAt, paths } = yield* commitsIn(repo, `-1 ${sha}`);
        const commit = commits[0]!;
        const files = paths.get(sha) ?? [];
        const local = yield* resolve(repo, LEDGER_REF);
        const current =
          Option.getOrNull(yield* readEntry(repo, sha)) ??
          buildEntry({
            commit,
            links: [],
            paths: files,
            outputs: true,
            maxOutput: 0,
            home: config.home,
          });

        let entry: LedgerEntry;
        let linked: LedgerLink | null = null;
        if ("unlink" in change) {
          const { named } = yield* loadSessions(repo, "auto");
          const ids = new Set([change.unlink, ...named(change.unlink).map((s) => s.thread.id)]);
          const links = current.links.filter((l) => !ids.has(l.thread.id));
          if (links.length === current.links.length)
            return yield* new LedgerFailed({
              message: `${sha.slice(0, 8)} has no link to ${change.unlink}`,
            });
          const gone = current.links.filter((l) => ids.has(l.thread.id)).map((l) => l.thread.id);
          entry = {
            ...current,
            links,
            unlinked: [...new Set([...current.unlinked, ...gone])],
            files: fileCoverage(files, links),
          };
        } else {
          let fresh: LedgerEntry;
          let relink: string[] = [];
          if ("note" in change) {
            const { file } = change.note;
            if (file !== null && !files.includes(file))
              return yield* new LedgerFailed({
                message: `${file} is not among the files ${sha.slice(0, 8)} changed`,
              });
            fresh = buildEntry({
              commit,
              links: [],
              paths: files,
              notes: [
                { text: change.note.text, file, at: DateTime.formatIso(yield* DateTime.now) },
              ],
              outputs: true,
              maxOutput: 0,
              home: config.home,
            });
          } else {
            const { sources, named } = yield* loadSessions(repo, "auto");
            const s = named(change.link.session)[0];
            if (!s)
              return yield* new LedgerFailed({
                message: `No session ${change.link.session} in ${sources.join(" + ") || "any source"} for ${repo}`,
              });
            // A review comes after the commit: its history from the commit through now. Any
            // other role: from the commit's parent through the commit.
            const now = DateTime.formatIso(yield* DateTime.now);
            const segment =
              change.link.role === "reviewer"
                ? segmentByTime(s.entries, commit.committedAt, now)
                : segmentByTime(s.entries, previousAt.get(sha) ?? null, commit.committedAt);
            relink = [s.thread.id];
            fresh = buildEntry({
              commit,
              links: [
                {
                  thread: s.thread,
                  role: change.link.role,
                  via: "asserted",
                  reviewedSha: change.link.reviewed ? sha : null,
                  segment,
                  labels: s.labels,
                  root: s.root,
                },
              ],
              paths: files,
              outputs: SYNC_DEFAULTS.outputs,
              maxOutput: SYNC_DEFAULTS.maxOutput,
              home: config.home,
            });
          }
          // The whole entry, so a subject first stored here leaves sanitized too.
          entry = (yield* sanitizeAll(repo, [mergeEntries(current, fresh, relink)], {
            mode: null,
            agent: null,
          })).entries[0]!;
          const made = fresh.links[0];
          linked =
            entry.links.find((l) => l.thread.id === made?.thread.id && l.role === made.role) ??
            null;
        }
        if (!sameEntry(entry, current)) {
          const head = yield* writeTree(
            repo,
            local ? [local] : [],
            [{ commit, entry }],
            `ledger: ${Object.keys(change)[0]} ${sha.slice(0, 8)}`,
          );
          yield* git(repo, ["update-ref", LEDGER_REF, head, local ?? ""]);
        }
        return { entry, linked };
      });

      const sanitizeAll = (
        repo: string,
        entries: ReadonlyArray<LedgerEntry>,
        choice: SanitizeChoice,
      ) =>
        sanitizer
          .sanitize(repo, entries, choice)
          .pipe(Effect.mapError((e) => new LedgerFailed({ message: `sanitize: ${e.message}` })));
      const summary = (r: {
        mode: SanitizeSummary["mode"];
        hits: number;
        spans: ReadonlyArray<unknown> | null;
      }) => ({
        mode: r.mode,
        hits: r.hits,
        spans: r.spans ? r.spans.length : null,
      });

      const sanitizeBranch = Effect.fn("Ledger.sanitize")(function* (
        repoArg: string,
        choice: SanitizeChoice & { readonly push: boolean },
      ) {
        const repo = (yield* git(repoArg, ["rev-parse", "--show-toplevel"])).trim();
        yield* ensureNotCheckedOut(repo);
        const remote = choice.push ? yield* fetchRemote(repo) : null;
        const local = yield* resolve(repo, LEDGER_REF);
        // Every entry either side has; the local copy wins.
        const from = new Map<string, string>();
        for (const ref of [remote, local])
          for (const file of yield* filesIn(repo, ref))
            if (ref && file.startsWith("commits/")) from.set(file, ref);
        const entries: LedgerEntry[] = [];
        for (const [file, ref] of from)
          entries.push(
            yield* git(repo, ["show", `${ref}:${file}`]).pipe(
              Effect.flatMap(decodeEntry),
              Effect.mapError(
                (e) => new LedgerFailed({ message: `${ref.slice(0, 8)}:${file}: ${e.message}` }),
              ),
            ),
          );
        const result = yield* sanitizeAll(repo, entries, choice);
        if (entries.length === 0)
          return { ...summary(result), entries: 0, head: local, pushed: null };
        const writes: Write[] = [];
        for (const entry of result.entries) writes.push({ commit: entry.commit, entry });
        const head = yield* writeTree(
          repo,
          [],
          writes,
          `ledger: ${writes.length} entries, sanitized (${result.mode})`,
        );
        let pushed: string | null = null;
        if (choice.push) {
          yield* git(repo, [
            "push",
            "--quiet",
            "--no-verify",
            `--force-with-lease=${LEDGER_REF}:${remote ?? ""}`,
            REMOTE,
            `${head}:${LEDGER_REF}`,
          ]);
          pushed = head;
        }
        yield* git(repo, ["update-ref", LEDGER_REF, head, local ?? ""]);
        return { ...summary(result), entries: writes.length, head, pushed };
      });

      const range = Effect.fn("Ledger.range")(function* (repoArg: string, rangeArg: string | null) {
        const repo = (yield* git(repoArg, ["rev-parse", "--show-toplevel"])).trim();
        const range = rangeArg ?? (yield* defaultRange(repo));
        const { commits } = yield* commitsIn(repo, range);
        const head = yield* resolve(repo, LEDGER_REF);
        const patchIds = head ? yield* readPatchIds(repo, head) : {};
        const views: LedgerCommitView[] = [];
        for (const commit of commits) {
          // Viewing skips an entry it can't read; only writes must stop on one.
          const direct = yield* readEntry(repo, commit.sha).pipe(
            Effect.orElseSucceed(() => Option.none<LedgerEntry>()),
          );
          if (Option.isSome(direct)) {
            views.push({ commit, entry: direct.value, matchedBy: "sha" });
            continue;
          }
          // Rebased or amended: same diff, new SHA.
          const original = commit.patchId ? patchIds[commit.patchId] : undefined;
          const moved = original
            ? yield* readEntry(repo, original).pipe(
                Effect.orElseSucceed(() => Option.none<LedgerEntry>()),
              )
            : Option.none<LedgerEntry>();
          views.push({
            commit,
            entry: Option.getOrNull(moved),
            matchedBy: Option.isSome(moved) ? "patch-id" : null,
          });
        }
        const remote = yield* gitOption(repo, ["remote", "get-url", "origin"]);
        return { repo, range, remoteUrl: remoteWebUrl(Option.getOrNull(remote)), commits: views };
      });

      /** Installs or removes one hook file; ours means exactly what we write. */
      const hookFile = Effect.fn("Ledger.hookFile")(
        function* (repo: string, name: string, script: string, action: "install" | "uninstall") {
          const file = path.resolve(
            repo,
            (yield* git(repo, ["rev-parse", "--git-path", `hooks/${name}`])).trim(),
          );
          const current = (yield* exists(file)) ? yield* fs.readFileString(file) : null;
          // A marked hook someone edited is theirs now.
          const changed = current !== null && current !== script && current.includes(HOOK_MARKER);
          const foreign = current !== null && current !== script && !changed;
          if (changed)
            return yield* new LedgerFailed({
              message: `${file} has changed since toolreader wrote it; leaving it alone. Edit or remove it by hand.`,
            });
          if (action === "uninstall") {
            if (current === null) return `No ${name} hook at ${file}.`;
            if (foreign)
              return yield* new LedgerFailed({
                message: `${file} is not toolreader's hook; leaving it alone.`,
              });
            yield* fs.remove(file);
            return `Removed ${file}.`;
          }
          if (foreign)
            return yield* new LedgerFailed({
              message: [
                `${file} already exists and is not toolreader's; leaving it alone.`,
                `To chain the ledger, run this from it${name === "pre-push" ? " with the push's stdin (a copy, if your hook reads it too)" : ', with "$@"'}:`,
                // A subshell, so its `exit 0`s end only the ledger part.
                `(\n${script
                  .split("\n")
                  .filter((l) => l && !l.startsWith("#"))
                  .join("\n")}\n)`,
              ].join("\n"),
            });
          if (current === script) return `Already installed: ${file}.`;
          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
          yield* fs.writeFileString(file, script);
          yield* fs.chmod(file, 0o755);
          return `Installed ${file}.`;
        },
        Effect.catchTag("PlatformError", (e) =>
          Effect.fail(new LedgerFailed({ message: e.message })),
        ),
      );

      const hook = Effect.fn("Ledger.hook")(function* (
        repo: string,
        action: "install" | "uninstall",
        command: string,
        options: { readonly commit?: boolean } = {},
      ) {
        const lines = [yield* hookFile(repo, "pre-push", prePushHook(command), action)];
        // Uninstall removes the commit hook too, when it is ours.
        if (options.commit || action === "uninstall") {
          const commitHook = hookFile(repo, "commit-msg", commitMsgHook(), action);
          lines.push(
            options.commit
              ? yield* commitHook
              : yield* commitHook.pipe(Effect.orElseSucceed(() => "")),
          );
        }
        return lines
          .filter((l) => l && !(action === "uninstall" && l.startsWith("No commit-msg")))
          .join("\n");
      });

      const site = Effect.fn("Ledger.site")(
        function* (repo: string, rangeArg: string | null, out: string) {
          const view = publicRange(yield* range(repo, rangeArg), config.home);
          const templateFile = path.join(config.distDir, "site", "index.html");
          const template = (yield* exists(templateFile))
            ? yield* fs.readFileString(templateFile)
            : "";
          const html = ledgerSiteHtml(template, view);
          if (html === null)
            return yield* new LedgerFailed({
              message: `No site template at ${templateFile}; build it with \`vp run build\`.`,
            });
          const file = path.resolve(out, "index.html");
          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
          yield* fs.writeFileString(file, html);
          return { file, view };
        },
        Effect.catchTag("PlatformError", (e) =>
          Effect.fail(new LedgerFailed({ message: e.message })),
        ),
      );

      return Ledger.of({ sync, range, site, hook, assert, sanitize: sanitizeBranch });
    }),
  );
}
