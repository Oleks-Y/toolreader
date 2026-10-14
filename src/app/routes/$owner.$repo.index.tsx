import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { fmtDay, fmtTime } from "../../web/util.ts";
import { ledgerOptions } from "../queries.ts";

export const Route = createFileRoute("/$owner/$repo/")({
  loader: ({ context, params }) =>
    context.queryClient.ensureInfiniteQueryData(ledgerOptions(`${params.owner}/${params.repo}`)),
  component: Ledger,
});

function Ledger() {
  const { owner, repo } = Route.useParams();
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useSuspenseInfiniteQuery(
    ledgerOptions(`${owner}/${repo}`),
  );
  const rows = data.pages.flat();
  return (
    <div className="app-list">
      {rows.length === 0 && <p className="dim">No commit here has agent history yet.</p>}
      {rows.map((c) => (
        <Link
          key={c.sha}
          className="item"
          to="/$owner/$repo/commit/$sha"
          params={{ owner, repo, sha: c.sha }}
        >
          <code className="sha">{c.sha.slice(0, 8)}</code>
          <span className="grow">{c.subject}</span>
          <span className="dim num" title="new lines its agents wrote, of all it adds">
            {c.novel > 0 ? `${c.explained}/${c.novel} lines` : ""}
          </span>
          <span className="dim num">
            {c.threads} thread{c.threads === 1 ? "" : "s"} · {c.via.join(", ")}
          </span>
          <span className="dim num">
            {fmtDay(c.committedAt)} {fmtTime(c.committedAt)}
          </span>
        </Link>
      ))}
      {hasNextPage && (
        <button className="chip" disabled={isFetchingNextPage} onClick={() => fetchNextPage()}>
          {isFetchingNextPage ? "loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}
