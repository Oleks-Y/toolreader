// Blame for one line of a GitHub diff, in the webapp: GitHub's blame finds the commit that last
// wrote the line, the backend gives that commit's linked threads, and Jev judges which of their
// pieces produced the line's hunk (core/blame.ts). The answer is kept on the backend per hunk and
// model, so only the first reader of a hunk asks TypeSafe. Unlike src/server/Blame.ts it needs no
// clone and no local sessions.
import * as NodeCrypto from "node:crypto";

import * as Schema from "effect/Schema";

import {
  BLAME_MODEL,
  buildRequest,
  hunksOf,
  oddsOf,
  parseLineLink,
  piecesOf,
  SystemOneResponse,
  type BlameResult,
  type Hunk,
  type StoredBlame,
} from "../../core/blame.ts";
import type { Entry } from "../../core/domain.ts";
import { lineKey } from "../../core/history.ts";
import { episode } from "../../core/historyPage.ts";
import { redactor } from "../../core/proof.ts";
import * as backend from "./backend.ts";
import { typesafeKey } from "./env.ts";
import * as github from "./github.ts";
import type { User } from "./session.ts";

const decodeResponse = Schema.decodeUnknownSync(SystemOneResponse);

export class BlameFailed extends Error {}

const fileHash = (path: string) => NodeCrypto.createHash("sha256").update(path).digest("hex");

/** The hunk of `detail` that adds `text` to `path`, and that line's number in the commit. */
function hunkWith(detail: github.CommitDetail, path: string, text: string) {
  const file = detail.files.find((f) => f.filename === path);
  if (!file?.patch) return null;
  const diff = `diff --git a/${path} b/${path}\n--- a/${file.previous_filename ?? path}\n+++ b/${path}\n${file.patch}`;
  const want = lineKey(text);
  for (const hunk of hunksOf(diff)) {
    let at = Number(/\+(\d+)/.exec(hunk.header)?.[1] ?? 0);
    for (const l of hunk.text.split("\n")) {
      if (l.startsWith("+") && lineKey(l.slice(1)) === want) return { hunk, line: at };
      if (!l.startsWith("-")) at++;
    }
  }
  return null;
}

export async function blameLine(user: User, url: string): Promise<BlameResult> {
  const link = parseLineLink(url);
  if (!link)
    throw new BlameFailed(
      "Not a GitHub diff line link: open the PR's (or commit's) files, click a line number and copy the address",
    );
  if (link.side === "L")
    throw new BlameFailed("That line is on the old side of the diff; pick one on the new side");
  const repo = link.repoUrl.replace("https://github.com/", "");
  if (!(await github.canRead(user.token, user.login, repo)))
    throw new BlameFailed(`You can't read ${repo} on GitHub`);

  // The revision the link shows, and the path behind its hash.
  let rev: string;
  let paths: string[];
  if (link.pr !== null) {
    rev = (await github.pull(user.token, repo, link.pr)).head.sha;
    paths = await github.pullFiles(user.token, repo, link.pr);
  } else {
    const detail = await github.commit(user.token, repo, link.sha!);
    rev = detail.sha;
    paths = detail.files.map((f) => f.filename);
  }
  const path = paths.find((p) => fileHash(p) === link.fileHash);
  if (!path) throw new BlameFailed("The linked file isn't among the files this diff changes");

  const text = (await github.fileAt(user.token, repo, path, rev)).split("\n")[link.line - 1];
  if (text === undefined) throw new BlameFailed(`${path} has no line ${link.line}`);
  const sha = await github.blameCommit(user.token, repo, rev, path, link.line);
  if (!sha) throw new BlameFailed("GitHub's blame found no commit for that line");
  const detail = await github.commit(user.token, repo, sha);
  const found = hunkWith(detail, path, text);
  if (!found) throw new BlameFailed(`Commit ${sha.slice(0, 8)} has no hunk that adds that line`);

  const [record] = await backend.commits(repo, [sha]);
  if (!record || record.links.length === 0)
    throw new BlameFailed(`No agent thread is linked to ${sha.slice(0, 8)}`);
  const records = await backend.threads(record.links.map((l) => l.threadId));
  const byId = new Map(records.map((t) => [t.thread.id, t]));
  const answer =
    (await backend.storedBlame(repo, sha, path, found.hunk.header, BLAME_MODEL)) ??
    (await ask(
      repo,
      sha,
      record.subject,
      record.committedAt,
      path,
      found.hunk,
      record.links,
      byId,
    ));
  return {
    repoUrl: link.repoUrl,
    commit: { sha, subject: record.subject, committedAt: record.committedAt },
    path,
    line: found.line,
    hunk: { header: found.hunk.header, text: found.hunk.text },
    threads: record.links.flatMap((l) => {
      const t = byId.get(l.threadId);
      if (!t) return [];
      // The linked turns and the short runs between them, as the PR page shows them.
      const entries = l.turns.length > 0 ? episode(t.entries, new Set(l.turns)) : t.entries;
      return [{ id: l.threadId, title: t.thread.title, entries: [...entries] }];
    }),
    pieces: answer.pieces,
    main: answer.main,
    model: answer.model,
    inputTokens: answer.inputTokens,
  };
}

/** Asks Jev about one hunk and keeps the answer on the backend. */
async function ask(
  repo: string,
  sha: string,
  subject: string,
  committedAt: string,
  path: string,
  hunk: Hunk,
  links: ReadonlyArray<{ readonly threadId: string; readonly turns: ReadonlyArray<string> }>,
  byId: ReadonlyMap<string, { readonly entries: ReadonlyArray<Entry> }>,
): Promise<StoredBlame> {
  const key = typesafeKey();
  if (!key) throw new BlameFailed("The server has no TypeSafe key (TYPESAFE_API_KEY)");
  const pieces = piecesOf(links, (id) => byId.get(id)?.entries, committedAt);
  if (pieces.length === 0) throw new BlameFailed("The linked turns ran nothing that can write");
  // The records were redacted when synced; this catches what a newer redactor knows.
  const { clean } = redactor();
  const request = buildRequest({ subject, hunk: { ...hunk, path }, pieces }, clean);
  const response = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(request.body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new BlameFailed(`TypeSafe answered HTTP ${response.status}`);
  const decoded = decodeResponse(await response.json());
  const odds = oddsOf(request, decoded);
  if (!odds) throw new BlameFailed("TypeSafe's answer lacks a question");
  const stored: StoredBlame = {
    repo,
    sha,
    path,
    hunk: { header: hunk.header, text: hunk.text },
    threadIds: [...new Set(links.map((l) => l.threadId))],
    ...odds,
    model: decoded.model,
    inputTokens: decoded.usage.input_tokens ?? 0,
  };
  await backend.putBlame(stored);
  return stored;
}
