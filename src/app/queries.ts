// Query options shared by route loaders (which fill the cache on the server) and components.
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import {
  blameLine,
  getCommitHistory,
  getLedger,
  getMe,
  getPullHistory,
  listPulls,
  listRepos,
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
