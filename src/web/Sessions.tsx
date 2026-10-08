import { useEffect, useMemo, useRef, useState } from "react";
import type { ThreadSummary } from "../core/domain.ts";
import { call, errorMessage } from "./client.ts";
import { ThemePicker } from "./theme.tsx";
import { since } from "./util.ts";

/** Which sessions to show; scripted `codex exec` runs are hidden by default. */
type Shown = {
  t3: boolean;
  codex: boolean;
  claude: boolean;
  scripted: boolean;
  archived: boolean;
};
const SHOWN_KEY = "toolreader.sessions";

function loadShown(): Shown {
  const defaults: Shown = {
    t3: true,
    codex: true,
    claude: true,
    scripted: false,
    archived: false,
  };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SHOWN_KEY) ?? "{}") };
  } catch {
    return defaults;
  }
}

const badge = (t: ThreadSummary) =>
  t.source === "t3" ? `t3 · ${t.provider ?? "?"}` : (t.origin ?? t.source);

export function Sessions() {
  const [threads, setThreads] = useState<ReadonlyArray<ThreadSummary> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const filterInput = useRef<HTMLInputElement>(null);
  const [shown, setShown] = useState<Shown>(loadShown);
  useEffect(() => localStorage.setItem(SHOWN_KEY, JSON.stringify(shown)), [shown]);

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
      if (t.archived && !shown.archived) continue;
      if (!shown[t.source]) continue;
      if (t.origin === "codex_exec" && !shown.scripted) continue;
      if (q && !`${t.title} ${t.projectTitle} ${badge(t)}`.toLowerCase().includes(q)) continue;
      const g = byProject.get(t.projectId) ?? { title: t.projectTitle, threads: [] };
      g.threads.push(t);
      byProject.set(t.projectId, g);
    }
    // Threads arrive newest first, so groups end up ordered by their newest thread.
    return [...byProject.values()];
  }, [threads, query, shown]);

  const running = threads?.filter((t) => t.status === "running").length ?? 0;

  return (
    <main className="sessions">
      <header className="topbar">
        <h1>toolreader</h1>
        <ThemePicker />
        <a href="#/file">open proof file</a>
        <a href="#/ledger">commit ledger</a>
        <input
          ref={filterInput}
          autoFocus
          aria-label="Filter sessions"
          placeholder="Filter threads…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !e.nativeEvent.isComposing) {
              setQuery("");
            }
          }}
        />
        {query !== "" && (
          <button
            type="button"
            className="chip"
            onClick={() => {
              setQuery("");
              filterInput.current?.focus();
            }}
          >
            Clear
          </button>
        )}
        {(["t3", "codex", "claude", "scripted", "archived"] as const).map((key) => (
          <label key={key} className="switch">
            <input
              type="checkbox"
              checked={shown[key]}
              onChange={(e) => setShown((s) => ({ ...s, [key]: e.target.checked }))}
            />{" "}
            {key}
          </label>
        ))}
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
              <span className={`provider source-${t.source}`}>{badge(t)}</span>
              <span className="dim num">
                {t.actionCount === null ? "" : `${t.actionCount} actions`}
              </span>
              <span className="dim num">{since(t.updatedAt)}</span>
            </a>
          ))}
        </section>
      ))}
      {threads && groups.length === 0 && <p className="dim">No threads match.</p>}
    </main>
  );
}
