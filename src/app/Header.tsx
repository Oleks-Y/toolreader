import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { ThemePicker } from "../web/theme.tsx";
import { meOptions } from "./queries.ts";

export function Header({ children }: { children?: ReactNode }) {
  const { data: me } = useQuery(meOptions);
  return (
    <header className="topbar">
      <h1>
        <Link to="/">agent history</Link>
      </h1>
      {children}
      <ThemePicker />
      {me?.login && (
        <span className="dim">
          {me.login} · <a href="/auth/logout">sign out</a>
        </span>
      )}
    </header>
  );
}
