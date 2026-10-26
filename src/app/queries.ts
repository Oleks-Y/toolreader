// Query options shared by route loaders (which fill the cache on the server) and components.
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import type { ActionKind } from "../core/domain.ts";
import type { Cite } from "./cite.ts";
import {
  blameLine,
  getCommitHistory,
  getLedger,
  getMe,
  getPullHistory,
  listPulls,
  getSessionTitles,
  listFindings,
  listRepos,
  readCitation,
  searchSessions,
} from "./fns.ts";

export const meOptions = queryOptions({ queryKey: ["me"], queryFn: () => getMe() });

export const reposOptions = queryOptions({
  queryKey: ["repos"],
  queryFn: () => listRepos(),
  staleTime: 60_000,
});

export const ledgerOptions = (repo: string) =>
  infiniteQueryOptions({
    queryKey: ["ledger", repo],
    queryFn: ({ pageParam }) => getLedger({ data: { repo, before: pageParam } }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => (page.length < 30 ? null : (page.at(-1)?.sha ?? null)),
    staleTime: 60_000,
  });

export const pullsOptions = (repo: string) =>
  queryOptions({
    queryKey: ["pulls", repo],
    queryFn: () => listPulls({ data: { repo } }),
    staleTime: 5 * 60_000,
  });

export const pullHistoryOptions = (repo: string, number: number) =>
  queryOptions({
    queryKey: ["pull", repo, number],
    queryFn: () => getPullHistory({ data: { repo, number } }),
    staleTime: 5 * 60_000,
  });

export const commitHistoryOptions = (repo: string, sha: string) =>
  queryOptions({
    queryKey: ["commit", repo, sha],
    queryFn: () => getCommitHistory({ data: { repo, sha } }),
    staleTime: 5 * 60_000,
  });

export const blameOptions = (url: string) =>
  queryOptions({
    queryKey: ["blame", url],
    queryFn: () => blameLine({ data: { url } }),
    // Revalidate because synced evidence can change.
    staleTime: 0,
    retry: false,
  });

/** A search: its text, the commit whose sessions it keeps, the action kinds it keeps. */
export type SearchQuery = {
  readonly text?: string | undefined;
  readonly commit?: string | undefined;
  readonly kinds?: ReadonlyArray<ActionKind> | undefined;
};

export const searchOptions = (repo: string, q: SearchQuery) =>
  queryOptions({
    queryKey: ["search", repo, q.text ?? "", q.commit ?? "", ...(q.kinds ?? [])],
    queryFn: () =>
      searchSessions({
        data: {
          repo,
          ...(q.text ? { text: q.text } : {}),
          ...(q.commit ? { commit: q.commit } : {}),
          ...(q.kinds?.length ? { kinds: [...q.kinds] } : {}),
        },
      }),
    staleTime: 60_000,
  });

export const citationOptions = (repo: string, cite: Cite) =>
  queryOptions({
    queryKey: ["citation", repo, cite.threadId, cite.entryId, cite.version],
    queryFn: () => readCitation({ data: { repo, ...cite } }),
    staleTime: 5 * 60_000,
  });

export const findingsOptions = (repo: string) =>
  queryOptions({
    queryKey: ["findings", repo],
    queryFn: () => listFindings({ data: { repo } }),
    staleTime: 60_000,
  });

export const titlesOptions = (repo: string, ids: ReadonlyArray<string>) =>
  queryOptions({
    queryKey: ["titles", repo, ...ids],
    queryFn: () => getSessionTitles({ data: { repo, ids: [...ids] } }),
    staleTime: 5 * 60_000,
  });
