// The history backend (core/historyApi.ts), read with the workspace's token, which only the app
// server holds.
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
import { env } from "./env.ts";

const runtime = ManagedRuntime.make(FetchHttpClient.layer);

const client = () => {
  const { backendUrl, backendToken } = env();
  return HttpApiClient.make(BackendApi, {
    baseUrl: backendUrl,
    transformClient: (c) =>
      c.pipe(
        HttpClient.mapRequest(
          HttpClientRequest.setHeaders({
            authorization: `Bearer ${backendToken}`,
            [CLIENT_HEADER]: packageJson.version,
          }),
        ),
      ),
  });
};

type Api = Effect.Success<ReturnType<typeof client>>;
const run = <A, E>(f: (api: Api, ws: string) => Effect.Effect<A, E>): Promise<A> =>
  runtime.runPromise(
    Effect.flatMap(client(), (api) => f(api, env().workspace)).pipe(Effect.timeout("60 seconds")),
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

export async function threads(ids: ReadonlyArray<string>): Promise<ThreadRecord[]> {
  const parts = await Promise.all(
    chunks([...new Set(ids)], LIMITS.threads).map((part) =>
      run((api, ws) => api.history.threads({ params: { ws }, payload: { ids: part } })),
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
