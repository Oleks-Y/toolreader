// A search hit's citation in the search page's URL: `thread#entry@version`, as `history search`
// prints it, or `thread#entry` for a finding's citation. Thread ids hold `:`; the last `#` splits.
import type { SearchHit } from "../core/historyApi.ts";

export type Cite = {
  readonly threadId: string;
  readonly entryId: string;
  /** The thread's version it was found in; a finding's citations don't keep one. */
  readonly version?: string | undefined;
};

export const citeOf = (
  h: Pick<SearchHit, "threadId" | "entryId"> & { readonly version?: string },
) => `${h.threadId}#${h.entryId}${h.version ? `@${h.version}` : ""}`;

export const parseCite = (s: string): Cite | null => {
  const m = /^(.+)#([^#@]+)(?:@([0-9a-f]+))?$/.exec(s);
  if (!m) return null;
  const [, threadId, entryId, version] = m;
  return { threadId: threadId!, entryId: entryId!, ...(version ? { version } : {}) };
};
