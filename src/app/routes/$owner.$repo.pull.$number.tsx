import { useSuspenseQuery } from "@tanstack/react-query";
import { ClientOnly, createFileRoute } from "@tanstack/react-router";

import { LedgerCommits } from "../../web/LedgerPage.tsx";
import { pullHistoryOptions } from "../queries.ts";

export const Route = createFileRoute("/$owner/$repo/pull/$number")({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(
      pullHistoryOptions(`${params.owner}/${params.repo}`, Number(params.number)),
    ),
  component: Pull,
});

function Pull() {
  const { owner, repo, number } = Route.useParams();
  const { data } = useSuspenseQuery(pullHistoryOptions(`${owner}/${repo}`, Number(number)));
  const withHistory = data.range.commits.filter((c) => (c.entry?.links.length ?? 0) > 0).length;
  return (
    <>
      <p>
        <a href={data.url} target="_blank" rel="noreferrer">
          #{number} {data.title}
        </a>{" "}
        <span className="dim">
          · {data.range.commits.length} commits · {withHistory} with agent history
        </span>
      </p>
      <ClientOnly fallback={<p className="dim">loading…</p>}>
        <LedgerCommits data={data.range} />
      </ClientOnly>
    </>
  );
}
