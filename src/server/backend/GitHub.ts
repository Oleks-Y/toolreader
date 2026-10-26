// Who a GitHub sign-in is, and whether they can read a repo, as GitHub answers with the caller's
// own token: the backend never holds more access than the person has. Answers are cached a
// minute per token, so access revoked on GitHub stops working here within a minute. Off (every
// sign-in refused) unless the backend is given a GitHub client id.
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { sha256 } from "../recordHash.ts";

export class GitHubFailed extends Schema.TaggedErrorClass<GitHubFailed>()("GitHubFailed", {
  message: Schema.String,
}) {}

export type GitHubConfig = {
  /** The OAuth or GitHub App client id people sign in through (device flow); public. */
  readonly clientId: string;
  /** GitHub's API, e.g. https://api.github.com. */
  readonly apiUrl: string;
  /** Where people sign in, e.g. https://github.com. */
  readonly webUrl: string;
};

const isGitHubFailed = Schema.is(GitHubFailed);
const User = Schema.Struct({ login: Schema.String });
const decodeUser = Schema.decodeUnknownEffect(User);
const RepoPermissions = Schema.Struct({
  permissions: Schema.optional(Schema.Struct({ pull: Schema.optional(Schema.Boolean) })),
});
const decodeRepo = Schema.decodeUnknownEffect(RepoPermissions);

/** `owner/name` as GitHub spells them: nothing that could change the URL it goes into. */
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const TTL_MS = 60_000;
/** Answers kept at most; all dropped past it. ponytail: no LRU at a pilot's handful of people. */
const MAX_CACHED = 5_000;

export class GitHub extends Context.Service<
  GitHub,
  {
    /** Null when sign-in is off. */
    readonly config: GitHubConfig | null;
    /** The token's user; none for a token GitHub doesn't accept. */
    readonly user: (token: string) => Effect.Effect<Option.Option<string>, GitHubFailed>;
    /** Whether the token's user can read `owner/name`. */
    readonly canRead: (token: string, repo: string) => Effect.Effect<boolean, GitHubFailed>;
  }
>()("toolreader/server/backend/GitHub") {
  static readonly disabled = Layer.succeed(
    GitHub,
    GitHub.of({
      config: null,
      user: () => Effect.succeed(Option.none()),
      canRead: () => Effect.succeed(false),
    }),
  );

  static readonly layer = (config: GitHubConfig) =>
    Layer.effect(
      GitHub,
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient;
        const cache = new Map<string, { at: number; value: unknown }>();
        const cached = <A>(key: string, get: Effect.Effect<A, GitHubFailed>) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const hit = cache.get(key);
            if (hit && now - hit.at < TTL_MS) return hit.value as A;
            const value = yield* get;
            if (cache.size >= MAX_CACHED) cache.clear();
            cache.set(key, { at: now, value });
            return value;
          });
        /** GET `path` as the token's user: the body, or null for 401, 403 and 404. */
        const get = (token: string, path: string): Effect.Effect<unknown, GitHubFailed> =>
          http
            .execute(
              HttpClientRequest.get(`${config.apiUrl}${path}`).pipe(
                HttpClientRequest.bearerToken(token),
                HttpClientRequest.setHeaders({
                  accept: "application/vnd.github+json",
                  "x-github-api-version": "2022-11-28",
                }),
              ),
            )
            .pipe(
              Effect.flatMap(
                (r): Effect.Effect<unknown, unknown> =>
                  r.status === 200
                    ? r.json
                    : [401, 403, 404].includes(r.status)
                      ? Effect.succeed(null)
                      : Effect.fail(new GitHubFailed({ message: `GitHub answered ${r.status}` })),
              ),
              Effect.timeout("10 seconds"),
              Effect.mapError((e) =>
                isGitHubFailed(e) ? e : new GitHubFailed({ message: "GitHub didn't answer" }),
              ),
            );
        const id = (token: string) => sha256(token);
        return GitHub.of({
          config,
          user: (token) =>
            cached(
              `user:${id(token)}`,
              Effect.flatMap(get(token, "/user"), (body) =>
                body === null
                  ? Effect.succeed(Option.none<string>())
                  : decodeUser(body).pipe(
                      Effect.map((u) => Option.some(u.login.toLowerCase())),
                      Effect.mapError(
                        () => new GitHubFailed({ message: "GitHub's /user changed" }),
                      ),
                    ),
              ),
            ),
          canRead: (token, repo) =>
            !REPO.test(repo) || repo.includes("..")
              ? Effect.succeed(false)
              : cached(
                  `repo:${id(token)}:${repo.toLowerCase()}`,
                  Effect.flatMap(get(token, `/repos/${repo}`), (body) =>
                    body === null
                      ? Effect.succeed(false)
                      : decodeRepo(body).pipe(
                          // A fine-grained or App token may list no permissions: seeing the repo is reading it.
                          Effect.map((r) => r.permissions?.pull !== false),
                          Effect.orElseSucceed(() => true),
                        ),
                  ),
                ),
        });
      }),
    );
}
