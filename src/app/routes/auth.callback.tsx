import { createFileRoute } from "@tanstack/react-router";

import { redirectTo } from "../server/redirect.ts";

import { me } from "../server/github.ts";
import { appSession, exchange } from "../server/session.ts";

export const Route = createFileRoute("/auth/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const session = await appSession();
        const state = session.data.state;
        await session.update({ state: undefined });
        // A callback this session didn't start (CSRF) or GitHub refused: start over.
        if (!state || url.searchParams.get("state") !== state) return redirectTo(request, "/login");
        const code = url.searchParams.get("code");
        const token = code ? await exchange({ code }) : null;
        if (!token) return redirectTo(request, "/login");
        const user = await me(token.token);
        await session.update({ user: { ...token, login: user.login } });
        return redirectTo(request, "/");
      },
    },
  },
});
