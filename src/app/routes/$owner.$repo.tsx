import { createFileRoute, Link, Outlet } from "@tanstack/react-router";

import { Header } from "../Header.tsx";

export const Route = createFileRoute("/$owner/$repo")({
  head: ({ params }) => ({ meta: [{ title: `${params.owner}/${params.repo} · agent history` }] }),
  component: RepoLayout,
});

function RepoLayout() {
  const { owner, repo } = Route.useParams();
  const params = { owner, repo };
  return (
    <main className="viewer">
      <Header>
        <span>
          <a href={`https://github.com/${owner}/${repo}`} target="_blank" rel="noreferrer">
            {owner}/{repo}
          </a>
        </span>
      </Header>
      <nav className="app-tabs">
        <Link to="/$owner/$repo" params={params} activeOptions={{ exact: true }}>
          Ledger
        </Link>
        <Link to="/$owner/$repo/pulls" params={params}>
          Pull requests
        </Link>
        <Link to="/$owner/$repo/blame" params={params}>
          Blame
        </Link>
      </nav>
      <Outlet />
    </main>
  );
}
