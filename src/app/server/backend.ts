// The history backend (core/historyApi.ts), read with the workspace's token, which only the app
// server holds.
import type { ActionKind } from "../../core/domain.ts";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import packageJson from "../../../package.json" with { type: "json" };
import type { StoredBlame } from "../../core/blame.ts";
import { BackendApi, CLIENT_HEADER, LIMITS } from "../../core/historyApi.ts";
import type { CommitRecord, ThreadRecord } from "../../core/historyRecord.ts";
import type { FindingStatus } from "../../core/insights.ts";
import { env } from "./env.ts";

const runtime = ManagedRuntime.make(FetchHttpClient.layer);

/** The workspace token by default; a person's GitHub token to act as them (Insights decisions). */
const client = (token = env().backendToken) =>
  HttpApiClient.make(BackendApi, {
    baseUrl: env().backendUrl,
    transformClient: (c) =>
      c.pipe(
        HttpClient.mapRequest(
          HttpClientRequest.setHeaders({
            authorization: `Bearer ${token}`,
            [CLIENT_HEADER]: packageJson.version,
          }),
        ),
      ),
  });

type Api = Effect.Success<ReturnType<typeof client>>;
const run = <A, E>(f: (api: Api, ws: string) => Effect.Effect<A, E>, token?: string): Promise<A> =>
  runtime.runPromise(
    Effect.flatMap(client(token), (api) => f(api, env().workspace)).pipe(
      Effect.timeout("60 seconds"),
    ),
  );

const chunks = <A>(items: ReadonlyArray<A>, size: number): A[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  );

export const repos = () =>
  run((api, ws) => api.browse.repos({ params: { ws } })).then((r) => r.repos);

export const ledger = (repo: string, before: string | null, limit = 30) =>
  run((api, ws) =>
    api.browse.ledger({
      params: { ws, repo },
      query: { ...(before ? { before } : {}), limit },
    }),
  ).then((r) => r.commits);

/** The commits of `shas` the backend has links for. */
export async function commits(repo: string, shas: ReadonlyArray<string>): Promise<CommitRecord[]> {
  const out: CommitRecord[] = [];
  for (const part of chunks(shas, LIMITS.ids))
    out.push(
      ...(
        await run((api, ws) =>
          api.history.commits({ params: { ws, repo }, payload: { shas: part } }),
        )
      ).commits,
    );
  return out;
}

/** Threads by id; with `repo`, only those linked to its commits. */
export async function threads(ids: ReadonlyArray<string>, repo?: string): Promise<ThreadRecord[]> {
  const parts = await Promise.all(
    chunks([...new Set(ids)], LIMITS.threads).map((part) =>
      run((api, ws) =>
        api.history.threads({ params: { ws }, payload: { ids: part, ...(repo ? { repo } : {}) } }),
      ),
    ),
  );
  return parts.flatMap((p) => p.threads);
}

export const storedBlame = (
  repo: string,
  sha: string,
  path: string,
  header: string,
  model: string,
) =>
  run((api, ws) =>
    api.browse.blame({ params: { ws, repo }, payload: { sha, path, header, model } }),
  ).then((r) => r.blame);

export const putBlame = (blame: StoredBlame) =>
  run((api, ws) => api.browse.putBlame({ params: { ws }, payload: blame }));

/** Entries of the repo's threads holding `text`, newest first, each cited at its version. */
export type SearchQuery = {
  readonly text?: string | undefined;
  readonly commit?: string | undefined;
  readonly kinds?: ReadonlyArray<ActionKind> | undefined;
};

export const search = (repo: string, q: SearchQuery, limit = 50) =>
  run((api, ws) =>
    api.history.search({
      params: { ws },
      payload: {
        repo,
        limit,
        ...(q.text ? { text: q.text } : {}),
        ...(q.commit ? { commit: q.commit } : {}),
        ...(q.kinds?.length ? { kinds: q.kinds } : {}),
      },
    }),
  );

/** A citation read back, limited to threads linked to the repo; else why not. */
export const evidence = (
  repo: string,
  cite: {
    readonly threadId: string;
    readonly entryId: string;
    readonly version?: string | undefined;
  },
) => run((api, ws) => api.history.evidence({ params: { ws }, payload: { ...cite, repo } }));

// Insights go as the signed-in person (`github:<login>` on each decision): the backend checks
// they're a workspace member and that GitHub lets them read the repo.

export const findings = (token: string, repo: string, statuses?: ReadonlyArray<FindingStatus>) =>
  run(
    (api, ws) =>
      api.history.findings({ params: { ws, repo }, payload: statuses ? { statuses } : {} }),
    token,
  ).then((r) => r.findings);

export const detect = (token: string, repo: string) =>
  run((api, ws) => api.history.detect({ params: { ws, repo } }), token);

export const transition = (
  token: string,
  repo: string,
  change: { readonly id: string; readonly to: FindingStatus; readonly why: string },
) =>
  run((api, ws) => api.history.transition({ params: { ws, repo }, payload: change }), token).then(
    (r) => r.finding,
  );
