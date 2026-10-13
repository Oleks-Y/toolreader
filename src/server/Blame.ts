// Blame for one line of a GitHub diff (core/blame.ts): `git blame` finds the commit that wrote the
// line, history linking (`history sync --dry-run`) finds that commit's threads, and TypeSafe's Jev
// judges which of their pieces produced the line's hunk. It sends the hunk and the pieces'
// commands, redacted and anonymized, to api.typesafe.ai: only when the page asks, with the key
// from TYPESAFE_API_KEY or ~/.toolreader/typesafe.key. Answers are kept for the server's life.
import * as NodeCrypto from "node:crypto";

import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { BlameFailed } from "../core/api.ts";
import {
  buildRequest,
  covers,
  hunksOf,
  oddsOf,
  parseLineLink,
  piecesOf,
  SystemOneResponse,
  type BlameResult,
} from "../core/blame.ts";
import { episode } from "../core/historyPage.ts";
import { remoteWebUrl } from "../core/ledger.ts";
import { redactor } from "../core/proof.ts";
import { textSanitizer } from "../core/sanitize.ts";
import { ClaudeTranscripts } from "./ClaudeTranscripts.ts";
import { CodexRollouts } from "./CodexRollouts.ts";
import { HistorySync } from "./history/HistorySync.ts";
import { RepoSessions } from "./RepoSessions.ts";
import { machineValues } from "./Sanitizer.ts";
import { ServerConfig } from "./ServerConfig.ts";
import { ThreadStore } from "./ThreadStore.ts";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const HEX = /^[0-9a-f]{40,64}$/;
const decodeResponse = HttpClientResponse.schemaBodyJson(SystemOneResponse);

/** GitHub's diff anchor for a file: the hex SHA-256 of its path. */
const fileHash = (path: string) => NodeCrypto.createHash("sha256").update(path).digest("hex");

export class Blame extends Context.Service<
  Blame,
  { readonly line: (url: string) => Effect.Effect<BlameResult, BlameFailed> }
>()("toolreader/server/Blame") {
  /** Needs an `HttpClient` (FetchHttpClient.layer in the app). */
  static readonly layer = Layer.effect(
    Blame,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const store = yield* ThreadStore;
      const rollouts = yield* CodexRollouts;
      const claude = yield* ClaudeTranscripts;
      const history = yield* HistorySync;
      const sessions = yield* RepoSessions;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.filterStatusOk,
        HttpClient.retryTransient({ schedule: Schedule.exponential("250 millis"), times: 2 }),
      );
      const fail = (message: string) => new BlameFailed({ message });

      /** git in `repo`; fails with its stderr. */
      const git = (repo: string, ...args: string[]) =>
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make("git", ["-C", repo, "-c", "core.quotePath=false", ...args]),
          );
          const [stdout, stderr, code] = yield* Effect.all(
            [
              handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
              handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          if (code !== ChildProcessSpawner.ExitCode(0))
            return yield* fail(`git ${args[0]}: ${stderr.trim() || `exit ${code}`}`);
          return stdout;
        }).pipe(
          Effect.scoped,
          Effect.catchTag("PlatformError", (e) => Effect.fail(fail(e.message))),
        );

      /** The local clone whose origin is `repoUrl`: found among the dirs sessions worked in. */
      const clones = new Map<string, string>();
      const findClone = Effect.fn("Blame.findClone")(function* (repoUrl: string) {
        const known = clones.get(repoUrl);
        if (known) return known;
        const lists = yield* Effect.all([store.list, rollouts.list, claude.list], {
          concurrency: "unbounded",
        });
        const dirs = new Set(lists.flat().flatMap((t) => (t.worktree ? [t.worktree] : [])));
        for (const dir of dirs) {
          const top = yield* git(dir, "rev-parse", "--show-toplevel").pipe(
            Effect.map((s) => s.trim()),
            Effect.orElseSucceed(() => ""),
          );
          if (!top) continue;
          const origin = yield* git(top, "remote", "get-url", "origin").pipe(
            Effect.orElseSucceed(() => ""),
          );
          if (remoteWebUrl(origin.trim())?.toLowerCase() === repoUrl.toLowerCase()) {
            clones.set(repoUrl, top);
            return top;
          }
        }
        return yield* fail(`no session worked in a clone of ${repoUrl}`);
      });

      /** The key, from the environment or the file a developer wrote it to. */
      const apiKey = Effect.gen(function* () {
        const env = yield* Config.option(Config.redacted("TYPESAFE_API_KEY")).pipe(
          Effect.orElseSucceed(() => Option.none()),
        );
        if (Option.isSome(env)) return env.value;
        const file = path.join(config.home, ".toolreader", "typesafe.key");
        const key = yield* fs.readFileString(file).pipe(
          Effect.map((k) => k.trim()),
          Effect.orElseSucceed(() => ""),
        );
        if (!key) return yield* fail(`set TYPESAFE_API_KEY or write the key to ${file}`);
        return Redacted.make(key);
      });

      const cache = new Map<string, BlameResult>();

      const line = Effect.fn("Blame.line")(function* (url: string) {
        const link = parseLineLink(url);
        if (!link)
          return yield* fail(
            "not a GitHub diff line link: open the PR's (or commit's) files, click a line number and copy the address",
          );
        if (link.side === "L")
          return yield* fail("that line is on the old side of the diff; pick one on the new side");
        const repo = yield* findClone(link.repoUrl);

        // The revision the link shows, and the files it changes (to read the path's hash back).
        let rev: string;
        let changed: string;
        if (link.pr !== null) {
          const pr = yield* spawner
            .string(
              ChildProcess.make("gh", [
                "pr",
                "view",
                String(link.pr),
                "--repo",
                link.repoUrl,
                "--json",
                "baseRefOid,headRefOid",
                "--jq",
                '.baseRefOid + " " + .headRefOid',
              ]),
            )
            .pipe(Effect.mapError((e) => fail(`PR ${link.pr}: ${e.message}`)));
          const [base = "", head = ""] = pr.trim().split(" ");
          if (!HEX.test(base) || !HEX.test(head))
            return yield* fail(`PR ${link.pr}: gh gave no base and head`);
          const has = (sha: string) =>
            git(repo, "cat-file", "-e", `${sha}^{commit}`).pipe(Effect.isSuccess);
          if (!(yield* has(head)))
            yield* git(repo, "fetch", "-q", "origin", `pull/${link.pr}/head`);
          if (!(yield* has(base))) yield* git(repo, "fetch", "-q", "origin", base);
          rev = head;
          changed = yield* git(repo, "diff", "--name-only", base, head);
        } else {
          rev = (yield* git(repo, "rev-parse", "--verify", `${link.sha}^{commit}`)).trim();
          changed = yield* git(
            repo,
            "diff-tree",
            "--no-commit-id",
            "--name-only",
            "-r",
            "--root",
            rev,
          );
        }
        const file = changed.split("\n").find((p) => p && fileHash(p) === link.fileHash);
        if (!file) return yield* fail("the linked file isn't among the files this diff changes");

        // The commit that last wrote the line, and where the line was in it.
        const porcelain = yield* git(
          repo,
          "blame",
          "--porcelain",
          "-L",
          `${link.line},${link.line}`,
          rev,
          "--",
          file,
        );
        const [sha = "", origLine = ""] = porcelain.split("\n")[0]!.split(" ");
        const origPath = /^filename (.*)$/m.exec(porcelain)?.[1] ?? file;
        if (!HEX.test(sha) || /^0+$/.test(sha))
          return yield* fail("git blame found no commit for that line");
        const at = Number(origLine);

        const hunk = hunksOf(
          yield* git(repo, "diff-tree", "-p", "-U3", "--no-color", "--no-ext-diff", "--root", sha),
        ).find((h) => covers(h, origPath, at));
        if (!hunk) return yield* fail(`no hunk of ${sha.slice(0, 8)} holds ${origPath}:${at}`);
        const key = `${sha}:${hunk.path}:${hunk.header}`;
        const cached = cache.get(key);
        if (cached) return { ...cached, line: at };

        // ponytail: sync and load each read every session of the repo; one pass if this gets slow.
        const report = yield* history
          .sync(repo, `-1 ${sha}`, { source: "auto", dryRun: true })
          .pipe(Effect.mapError((e) => fail(e.message)));
        const record = report.commits[0]?.record;
        if (!record || record.links.length === 0)
          return yield* fail(`no agent thread is linked to ${sha.slice(0, 8)}`);
        const loaded = yield* sessions
          .load(repo, "auto")
          .pipe(Effect.mapError((e) => fail(e.message)));
        const byId = new Map(loaded.sessions.map((s) => [s.thread.id, s]));
        const pieces = piecesOf(record.links, (id) => byId.get(id)?.entries, record.committedAt);
        if (pieces.length === 0) return yield* fail("the linked turns ran nothing that can write");

        // Worktree roots first (paths come out repo-relative), then secrets, home, and this
        // machine's identities, as a published ledger is anonymized.
        const roots = loaded.roots.toSorted((a, b) => b.length - a.length);
        const { clean: redact } = redactor(config.home);
        const local = yield* machineValues(config.home, [], repo).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const anonymize = textSanitizer({
          repo,
          home: config.home,
          allow: [],
          names: local.identities.filter((n) => n !== config.home),
          spans: [],
        });
        const clean = (s: string) =>
          anonymize(redact(roots.reduce((t, r) => t.split(`${r}/`).join(""), s))).text;
        const request = buildRequest({ subject: record.subject, hunk, pieces }, clean);

        const response = yield* HttpClientRequest.post(ENDPOINT).pipe(
          HttpClientRequest.bearerToken(yield* apiKey),
          HttpClientRequest.acceptJson,
          HttpClientRequest.bodyJsonUnsafe(request.body),
          client.execute,
          Effect.flatMap(decodeResponse),
          Effect.timeout(Duration.seconds(60)),
          Effect.mapError((e) =>
            fail(
              e._tag === "HttpClientError" && e.reason._tag === "StatusCodeError"
                ? `TypeSafe answered HTTP ${e.reason.response.status}`
                : `TypeSafe request failed: ${e._tag}`,
            ),
          ),
        );
        const odds = oddsOf(request, response);
        if (!odds) return yield* fail("TypeSafe's answer lacks a question");
        const result: BlameResult = {
          repoUrl: link.repoUrl,
          commit: { sha, subject: record.subject, committedAt: record.committedAt },
          path: hunk.path,
          line: at,
          hunk: { header: hunk.header, text: hunk.text },
          threads: record.links.flatMap((l) => {
            const s = byId.get(l.threadId);
            if (!s) return [];
            // The linked turns and the short runs between them, as the PR page shows them.
            const entries = l.turns.length > 0 ? episode(s.entries, new Set(l.turns)) : s.entries;
            return [{ id: l.threadId, title: s.thread.title, entries: [...entries] }];
          }),
          ...odds,
          model: response.model,
          inputTokens: response.usage.input_tokens ?? 0,
        };
        cache.set(key, result);
        return result;
      });

      return Blame.of({ line });
    }),
  );
}
