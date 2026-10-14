import { createFileRoute } from "@tanstack/react-router";

import { redirectTo } from "../server/redirect.ts";

import { env } from "../server/env.ts";
import { me } from "../server/github.ts";
import { appSession } from "../server/session.ts";

// Development only (GITHUB_DEV_TOKEN, refused in production): sign in as that token's user.
export const Route = createFileRoute("/auth/dev")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { devToken } = env();
        if (!devToken) return new Response("Not found", { status: 404 });
        const user = await me(devToken);
        await (
          await appSession()
        ).update({
          user: { login: user.login, token: devToken, refreshToken: null, expiresAt: null },
        });
        return redirectTo(request, "/");
      },
    },
  },
});
