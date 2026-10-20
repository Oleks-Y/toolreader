// The repo pages' data: the ledger (the backend's linked commits, newest first), the PRs whose
// commits have links (GitHub's PRs, the backend's links), and a PR's or a commit's agent history
// as the ledger page shows it (core/historyPage.ts `historyRange`, as `history site` builds it).
import { historyRange } from "../../core/historyPage.ts";
import type { CommitRecord, ThreadRecord } from "../../core/historyRecord.ts";
import type { FindingStatus } from "../../core/insights.ts";
import type { LedgerCommit, LedgerRange } from "../../core/ledger.ts";
import { splitTurns } from "../../core/tree.ts";
import * as backend from "./backend.ts";
import * as github from "./github.ts";
import type { User } from "./session.ts";

export class NotAllowed extends Error {}

/** Every repo function starts here: GitHub must let this user read the repo. */
export async function mustRead(user: User, repo: string) {
  if (!(await github.canRead(user.token, user.login, repo)))
    throw new NotAllowed(`You can't read ${repo} on GitHub`);
}

/** The backend's repos this user can read on GitHub. */
export async function repos(user: User) {
  const all = await backend.repos();
  const ok = await Promise.all(all.map((r) => github.canRead(user.token, user.login, r.repo)));
  return all.filter((_, i) => ok[i]);
}

export type LedgerRow = {
  readonly sha: string;
  readonly subject: string;
  readonly committedAt: string;
  readonly threads: number;
  readonly via: ReadonlyArray<string>;
  readonly explained: number;
  readonly novel: number;
};

export async function ledger(user: User, repo: string, before: string | null) {
  await mustRead(user, repo);
  return (await backend.ledger(repo, before)).map(
    (c): LedgerRow => ({
      sha: c.sha,
      subject: c.subject,
      committedAt: c.committedAt,
      threads: new Set(c.links.map((l) => l.threadId)).size,
      via: [...new Set(c.links.map((l) => l.via))],
      explained: c.explained,
      novel: c.novel,
    }),
  );
}

export type PullRow = {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed" | "merged";
  readonly author: string | null;
  readonly updatedAt: string;
  readonly url: string;
  readonly commits: number;
  readonly linked: number;
};

/** The 30 most recently updated PRs, those with at least one linked commit. */
export async function pulls(user: User, repo: string): Promise<PullRow[]> {
  await mustRead(user, repo);
  const prs = await github.pulls(user.token, repo);
  const shas = await Promise.all(
    prs.map((p) =>
      github.pullCommits(user.token, repo, p.number).then((cs) => cs.map((c) => c.sha)),
    ),
  );
  const linked = new Set(
    (await backend.commits(repo, shas.flat())).filter((c) => c.links.length > 0).map((c) => c.sha),
  );
  return prs.flatMap((p, i) => {
    const n = shas[i]!.filter((s) => linked.has(s)).length;
    if (n === 0) return [];
    return [
      {
        number: p.number,
        title: p.title,
        state: p.merged_at ? "merged" : p.state === "open" ? "open" : "closed",
        author: p.user?.login ?? null,
        updatedAt: p.updated_at,
        url: p.html_url,
        commits: shas[i]!.length,
        linked: n,
      },
    ];
  });
}

const rangeOf = async (
  repo: string,
  range: string,
  commits: ReadonlyArray<LedgerCommit>,
): Promise<LedgerRange> => {
  const records = new Map<string, CommitRecord>(
    (
      await backend.commits(
        repo,
        commits.map((c) => c.sha),
      )
    ).map((r) => [r.sha, r]),
  );
  const threads = new Map<string, ThreadRecord>(
    (
      await backend.threads([...records.values()].flatMap((r) => r.links.map((l) => l.threadId)))
    ).map((t) => [t.thread.id, t]),
  );
  return historyRange({
    repo,
    range,
    remoteUrl: `https://github.com/${repo}`,
    commits: commits.map((commit) => ({
      commit,
      paths: [],
      record: records.get(commit.sha) ?? null,
    })),
    threads,
  });
};

export async function pullHistory(user: User, repo: string, n: number) {
  await mustRead(user, repo);
  const [pr, commits] = await Promise.all([
    github.pull(user.token, repo, n),
    github.pullCommits(user.token, repo, n),
  ]);
  const range = await rangeOf(
    repo,
    `#${n}`,
    commits.map((c) => ({
      sha: c.sha,
      subject: c.commit.message.split("\n")[0] ?? "",
      committedAt: c.commit.committer?.date ?? "",
      patchId: null,
    })),
  );
  return { title: pr.title, url: pr.html_url, range };
}

export async function commitHistory(user: User, repo: string, sha: string) {
  await mustRead(user, repo);
  const [record] = await backend.commits(repo, [sha]);
  if (!record) return null;
  return rangeOf(repo, sha.slice(0, 8), [
    { sha: record.sha, subject: record.subject, committedAt: record.committedAt, patchId: null },
  ]);
}

export async function search(user: User, repo: string, q: backend.SearchQuery) {
  await mustRead(user, repo);
  return backend.search(repo, q);
}

export async function evidence(
  user: User,
  repo: string,
  cite: {
    readonly threadId: string;
    readonly entryId: string;
    readonly version?: string | undefined;
  },
) {
  await mustRead(user, repo);
  const found = await backend.evidence(repo, cite);
  if (found.status !== "ok" || !found.entry) return { ...found, title: null, turn: null };
  // ponytail: reads the whole thread for one turn; a turn read on the backend if threads get big.
  const [record] = await backend.threads([cite.threadId], repo);
  const turns = record ? splitTurns(record.entries) : [];
  const n = turns.findIndex(
    (t) => t.prompt?.id === cite.entryId || t.entries.some((e) => e.id === cite.entryId),
  );
  const turn = turns[n];
  return {
    ...found,
    title: record?.thread.title ?? null,
    turn: turn
      ? {
          n: n + 1,
          prompt: turn.prompt?.text.slice(0, 200) ?? null,
          steps: turn.entries.flatMap((e) =>
            e.type === "action"
              ? [
                  {
                    id: e.id,
                    at: e.at,
                    kind: e.kind,
                    status: e.status,
                    title: e.title,
                    added: (e.files ?? []).reduce((a, f) => a + f.added, 0),
                    removed: (e.files ?? []).reduce((a, f) => a + f.removed, 0),
                  },
                ]
              : [],
          ),
        }
      : null,
  };
}

/** The titles of the repo's sessions among `ids`, for naming a finding's citations. */
export async function sessionTitles(user: User, repo: string, ids: ReadonlyArray<string>) {
  await mustRead(user, repo);
  // ponytail: whole records for their titles; a titles read on the backend if this gets slow.
  const records = await backend.threads(ids, repo);
  return Object.fromEntries(records.map((r) => [r.thread.id, r.thread.title]));
}

export async function findings(user: User, repo: string) {
  await mustRead(user, repo);
  return backend.findings(user.token, repo);
}

export async function detect(user: User, repo: string) {
  await mustRead(user, repo);
  return backend.detect(user.token, repo);
}

export async function decide(
  user: User,
  repo: string,
  change: { readonly id: string; readonly to: FindingStatus; readonly why: string },
) {
  await mustRead(user, repo);
  return backend.transition(user.token, repo, change);
}
