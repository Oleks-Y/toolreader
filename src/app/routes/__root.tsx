import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import styleUrl from "../../web/style.css?url";
import themesUrl from "../../web/themes.css?url";
import { applySavedTheme } from "../../web/theme.tsx";
import appUrl from "../app.css?url";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "agent history" },
    ],
    links: [
      { rel: "stylesheet", href: themesUrl },
      { rel: "stylesheet", href: styleUrl },
      { rel: "stylesheet", href: appUrl },
    ],
  }),
  component: Root,
  errorComponent: ({ error }) => (
    <Document>
      <main className="viewer">
        <div className="error">{error instanceof Error ? error.message : String(error)}</div>
      </main>
    </Document>
  ),
});

function Root() {
  return (
    <Document>
      <Outlet />
    </Document>
  );
}

function Document({ children }: { children: ReactNode }) {
  useEffect(() => applySavedTheme(), []);
  const loading = useRouterState({ select: (s) => s.status === "pending" });
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className={loading ? "loading" : undefined}>
        <div id="root">{children}</div>
        <Scripts />
      </body>
    </html>
  );
}
