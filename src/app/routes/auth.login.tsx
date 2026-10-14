import * as NodeCrypto from "node:crypto";

import { createFileRoute } from "@tanstack/react-router";

import { env } from "../server/env.ts";
import { appSession } from "../server/session.ts";

// GitHub App user authorization: a state in the session, then GitHub's sign-in page.
export const Route = createFileRoute("/auth/login")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { githubClientId } = env();
        if (!githubClientId) return new Response("No GitHub App configured", { status: 503 });
        const state = NodeCrypto.randomBytes(16).toString("base64url");
        await (await appSession()).update({ state });
        const authorize = new URL("https://github.com/login/oauth/authorize");
        authorize.searchParams.set("client_id", githubClientId);
        authorize.searchParams.set("state", state);
        authorize.searchParams.set("redirect_uri", new URL("/auth/callback", request.url).href);
        return new Response(null, { status: 302, headers: { location: authorize.href } });
      },
    },
  },
});
