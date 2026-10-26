import { createFileRoute } from "@tanstack/react-router";

import { redirectTo } from "../server/redirect.ts";

import { appSession } from "../server/session.ts";

export const Route = createFileRoute("/auth/logout")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        await (await appSession()).clear();
        return redirectTo(request, "/login");
      },
    },
  },
});
