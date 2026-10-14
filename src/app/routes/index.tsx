import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { since } from "../../web/util.ts";
import { When } from "../../web/When.tsx";
import { Header } from "../Header.tsx";
import { reposOptions } from "../queries.ts";

export const Route = createFileRoute("/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(reposOptions),
  component: Repos,
});

function Repos() {
  const { data: repos } = useSuspenseQuery(reposOptions);
  const orgs = Map.groupBy(repos, (r) => r.repo.split("/")[0]!);
  return (
    <main className="viewer app-repos">
      <Header />
      {repos.length === 0 && (
        <p className="dim">No repo you can read has agent history yet. `history sync` sends it.</p>
      )}
      {[...orgs].map(([org, list]) => (
        <section key={org} className="project">
          <h2>
            {org} <span className="dim">{list.length} repos with agent history</span>
          </h2>
          {list.map((r) => {
            const [owner, repo] = r.repo.split("/") as [string, string];
            return (
              <Link key={r.repo} className="repo-row" to="/$owner/$repo" params={{ owner, repo }}>
                <b>{r.repo}</b>
                <span className="dim num">
                  {r.commits} commits · {r.threads} threads
                </span>
                <span className="dim num">
                  <When at={r.latest} as={since} />
                </span>
              </Link>
            );
          })}
        </section>
      ))}
    </main>
  );
}
