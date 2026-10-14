import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";

import { routeTree } from "./routeTree.gen";

// One QueryClient per router: Start makes a router per SSR request, so no reader's data can land
// in another reader's page.
export function getRouter() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
    // A route's error shows where the route renders, under the page's header and tabs.
    defaultErrorComponent: ({ error }) => (
      <div className="error">{error instanceof Error ? error.message : String(error)}</div>
    ),
  });
  setupRouterSsrQueryIntegration({ router, queryClient });
  return router;
}
