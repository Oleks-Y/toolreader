// GitHub's REST and GraphQL APIs, read with the signed-in user's token: a user sees only what
// GitHub lets them read, and the App's permissions (metadata, contents, pull requests: read)
// bound it further. Responses are decoded to the fields used.
import * as Schema from "effect/Schema";

const API = "https://api.github.com";

export class GitHubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const request = async (token: string, path: string, accept = "application/vnd.github+json") => {
  const response = await fetch(`${API}${path}`, {
    headers: {
      accept,
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "toolreader-webapp",
    },
  });
  if (!response.ok)
    throw new GitHubError(response.status, `GitHub answered ${response.status} for ${path}`);
  return response;
};

const get = async <A>(decode: (u: unknown) => A, token: string, path: string): Promise<A> =>
  decode(await (await request(token, path)).json());

const User = Schema.Struct({ login: Schema.String });
const Repo = Schema.Struct({
  full_name: Schema.String,
  private: Schema.Boolean,
  html_url: Schema.String,
});
const Pull = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  state: Schema.String,
  merged_at: Schema.NullOr(Schema.String),
  html_url: Schema.String,
  updated_at: Schema.String,
  user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  head: Schema.Struct({ sha: Schema.String }),
  base: Schema.Struct({ sha: Schema.String }),
});
export type Pull = typeof Pull.Type;
const PullCommit = Schema.Struct({
  sha: Schema.String,
  commit: Schema.Struct({
    message: Schema.String,
    committer: Schema.NullOr(Schema.Struct({ date: Schema.String })),
  }),
});
const FileEntry = Schema.Struct({
  filename: Schema.String,
  previous_filename: Schema.optional(Schema.String),
  patch: Schema.optional(Schema.String),
});
const CommitDetail = Schema.Struct({
  sha: Schema.String,
  commit: Schema.Struct({
    message: Schema.String,
    committer: Schema.NullOr(Schema.Struct({ date: Schema.String })),
  }),
  files: Schema.Array(FileEntry),
});
export type CommitDetail = typeof CommitDetail.Type;
const BlameRanges = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        object: Schema.NullOr(
          Schema.Struct({
            blame: Schema.Struct({
              ranges: Schema.Array(
                Schema.Struct({
                  startingLine: Schema.Number,
                  endingLine: Schema.Number,
                  commit: Schema.Struct({ oid: Schema.String }),
                }),
              ),
            }),
          }),
        ),
      }),
    ),
  }),
});

const decodeUser = Schema.decodeUnknownSync(User);
const decodeRepo = Schema.decodeUnknownSync(Repo);
const decodePulls = Schema.decodeUnknownSync(Schema.Array(Pull));
const decodePull = Schema.decodeUnknownSync(Pull);
const decodePullCommits = Schema.decodeUnknownSync(Schema.Array(PullCommit));
const decodeFiles = Schema.decodeUnknownSync(Schema.Array(FileEntry));
const decodeCommit = Schema.decodeUnknownSync(CommitDetail);
const decodeBlame = Schema.decodeUnknownSync(BlameRanges);

export const me = (token: string) => get(decodeUser, token, "/user");

/** Whether this user can read `owner/name`, kept 5 minutes per user and repo. */
const readable = new Map<string, { ok: boolean; at: number }>();
export async function canRead(token: string, login: string, repo: string): Promise<boolean> {
  const key = `${login}\n${repo.toLowerCase()}`;
  const hit = readable.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.ok;
  const ok = await get(decodeRepo, token, `/repos/${repo}`).then(
    () => true,
    (e: unknown) => {
      if (e instanceof GitHubError && (e.status === 404 || e.status === 403)) return false;
      throw e;
    },
  );
  readable.set(key, { ok, at: Date.now() });
  return ok;
}

export const pulls = (token: string, repo: string) =>
  get(decodePulls, token, `/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=30`);

export const pull = (token: string, repo: string, n: number) =>
  get(decodePull, token, `/repos/${repo}/pulls/${n}`);

/** A PR's commits, oldest first (GitHub lists up to 250). */
export const pullCommits = (token: string, repo: string, n: number) =>
  get(decodePullCommits, token, `/repos/${repo}/pulls/${n}/commits?per_page=100`);

/** The files a PR changes (paths only), up to 3000. */
export async function pullFiles(token: string, repo: string, n: number): Promise<string[]> {
  const names: string[] = [];
  for (let page = 1; page <= 30; page++) {
    const files = await get(
      decodeFiles,
      token,
      `/repos/${repo}/pulls/${n}/files?per_page=100&page=${page}`,
    );
    names.push(...files.map((f) => f.filename));
    if (files.length < 100) break;
  }
  return names;
}

export const commit = (token: string, repo: string, sha: string) =>
  get(decodeCommit, token, `/repos/${repo}/commits/${sha}`);

/** A file's text at a revision. */
export const fileAt = async (token: string, repo: string, path: string, rev: string) =>
  (
    await request(
      token,
      `/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${rev}`,
      "application/vnd.github.raw+json",
    )
  ).text();

/** The commit that last changed `line` of `path` at `rev`: GitHub's blame, through GraphQL. */
export async function blameCommit(
  token: string,
  repo: string,
  rev: string,
  path: string,
  line: number,
): Promise<string | null> {
  const [owner, name] = repo.split("/");
  const response = await fetch(`${API}/graphql`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "toolreader-webapp",
    },
    body: JSON.stringify({
      query: `query($owner: String!, $name: String!, $rev: String!, $path: String!) {
        repository(owner: $owner, name: $name) {
          object(expression: $rev) { ... on Commit { blame(path: $path) {
            ranges { startingLine endingLine commit { oid } }
          } } }
        }
      }`,
      variables: { owner, name, rev, path },
    }),
  });
  if (!response.ok)
    throw new GitHubError(response.status, `GitHub GraphQL answered ${response.status}`);
  const body = decodeBlame(await response.json());
  const range = body.data.repository?.object?.blame.ranges.find(
    (r) => r.startingLine <= line && line <= r.endingLine,
  );
  return range?.commit.oid ?? null;
}
