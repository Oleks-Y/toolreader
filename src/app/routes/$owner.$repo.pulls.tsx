import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { since } from "../../web/util.ts";
import { pullsOptions } from "../queries.ts";

export const Route = createFileRoute("/$owner/$repo/pulls")({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(pullsOptions(`${params.owner}/${params.repo}`)),
  component: Pulls,
});

function Pulls() {
  const { owner, repo } = Route.useParams();
  const { data: pulls } = useSuspenseQuery(pullsOptions(`${owner}/${repo}`));
  return (
    <div className="app-list">
      <p className="dim">The 30 most recently updated PRs, those with agent history.</p>
      {pulls.length === 0 && <p className="dim">None of them has agent history.</p>}
      {pulls.map((p) => (
        <Link
          key={p.number}
          className="item"
          to="/$owner/$repo/pull/$number"
          params={{ owner, repo, number: String(p.number) }}
        >
          <b>#{p.number}</b>
          <span className="grow">{p.title}</span>
          <span className="dim num" title="commits with agent history, of all">
            {p.linked}/{p.commits} commits
          </span>
          <span className={`provider ${p.state === "open" ? "source-codex" : "source-t3"}`}>
            {p.state}
          </span>
          <span className="dim num">
            {p.author ?? ""} · {since(p.updatedAt)}
          </span>
        </Link>
      ))}
    </div>
  );
}
