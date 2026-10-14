import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { meOptions } from "../queries.ts";

export const Route = createFileRoute("/login")({
  loader: ({ context }) => context.queryClient.ensureQueryData(meOptions),
  component: Login,
});

function Login() {
  const { data: me } = useSuspenseQuery(meOptions);
  return (
    <main className="viewer app-login">
      <h1>agent history</h1>
      <p className="dim">
        What coding agents did for each commit and PR. You see a repo's history when GitHub lets you
        read the repo.
      </p>
      {me.canSignIn && (
        <a className="chip on" href="/auth/login">
          Sign in with GitHub
        </a>
      )}
      {me.dev && (
        <a className="chip" href="/auth/dev">
          Continue with the dev token
        </a>
      )}
      {!me.canSignIn && !me.dev && (
        <div className="error">
          The server has no GitHub App (GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET).
        </div>
      )}
    </main>
  );
}
