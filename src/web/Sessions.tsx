import { useEffect, useMemo, useState } from "react";
import type { ThreadSummary } from "../core/domain.ts";
import { call, errorMessage } from "./client.ts";
import { since } from "./util.ts";

export function Sessions() {
  const [threads, setThreads] = useState<ReadonlyArray<ThreadSummary> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);

  useEffect(() => {
    document.title = "toolreader";
    const load = () =>
      call((api) => api.threads.list()).then(setThreads, (e: unknown) => setError(errorMessage(e)));
    load();
    const timer = setInterval(load, 5000); // cheap: counts are cached server-side
    return () => clearInterval(timer);
  }, []);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byProject = new Map<string, { title: string; threads: ThreadSummary[] }>();
    for (const t of threads ?? []) {
      if (t.archived && !archived) continue;
      if (q && !`${t.title} ${t.projectTitle} ${t.provider}`.toLowerCase().includes(q)) continue;
      const g = byProject.get(t.projectId) ?? { title: t.projectTitle, threads: [] };
      g.threads.push(t);
      byProject.set(t.projectId, g);
    }
    // Threads arrive newest first, so groups end up ordered by their newest thread.
    return [...byProject.values()];
  }, [threads, query, archived]);

  const running = threads?.filter((t) => t.status === "running").length ?? 0;

  return (
    <main className="sessions">
      <header className="topbar">
        <h1>toolreader</h1>
        <input
          autoFocus
          placeholder="Filter threads…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="switch">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />{" "}
          archived
        </label>
        <span className="dim">
          {threads ? `${threads.length} threads` : "loading…"}
          {running > 0 && <span className="running-count"> · {running} running</span>}
        </span>
      </header>
      {error && <div className="error">{error}</div>}
      {groups.map((g) => (
        <section key={g.title + g.threads[0]?.projectId} className="project">
          <h2>
            {g.title} <span className="dim">{g.threads.length}</span>
          </h2>
          {g.threads.map((t) => (
            <a
              key={t.id}
              className={`thread-row${t.archived ? " archived" : ""}`}
              href={`#/t/${encodeURIComponent(t.id)}`}
            >
              <span className={`status-dot ${t.status}`} title={t.status} />
              <span className="thread-title">{t.title}</span>
              <span className="provider">{t.provider ?? "?"}</span>
              <span className="dim num">{t.actionCount} actions</span>
              <span className="dim num">{since(t.updatedAt)}</span>
            </a>
          ))}
        </section>
      ))}
      {threads && groups.length === 0 && <p className="dim">No threads match.</p>}
    </main>
  );
}
