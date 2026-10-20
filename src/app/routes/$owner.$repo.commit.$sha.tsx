import { useSuspenseQuery } from "@tanstack/react-query";
import { ClientOnly, createFileRoute, Link } from "@tanstack/react-router";

import { LedgerCommits } from "../../web/LedgerPage.tsx";
import { commitHistoryOptions } from "../queries.ts";

export const Route = createFileRoute("/$owner/$repo/commit/$sha")({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(
      commitHistoryOptions(`${params.owner}/${params.repo}`, params.sha),
    ),
  component: Commit,
});

function Commit() {
  const { owner, repo, sha } = Route.useParams();
  const { data } = useSuspenseQuery(commitHistoryOptions(`${owner}/${repo}`, sha));
  if (!data) return <p className="dim">The backend has no agent history for {sha.slice(0, 8)}.</p>;
  // The history view measures the window (FileDiff): it renders in the browser only.
  return (
    <>
      <p>
        <Link to="/$owner/$repo/search" params={{ owner, repo }} search={{ commit: sha }}>
          Search this commit's sessions
        </Link>
      </p>
      <ClientOnly fallback={<p className="dim">loading…</p>}>
        <LedgerCommits data={data} />
      </ClientOnly>
    </>
  );
}
