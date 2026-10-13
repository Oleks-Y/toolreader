import { useEffect, useMemo, useState } from "react";

import { around, marksOf, type BlameResult, type Mark } from "../core/blame.ts";
import type { ThreadView } from "../core/domain.ts";
import { ActionView } from "./ActionView.tsx";
import { call, errorMessage } from "./client.ts";
import { FilePatch } from "./code.tsx";
import { ThemePicker } from "./theme.tsx";
import { fmtDay, fmtTime } from "./util.ts";

const sourceOf = (id: string) =>
  id.startsWith("claude:") ? "claude" : id.startsWith("codex:") ? "codex" : "t3";

/** A linked thread's turns as a read-only view, as the PR page shows them. */
function asView(thread: BlameResult["threads"][number], committedAt: string): ThreadView {
  return {
    thread: {
      id: thread.id,
      title: thread.title,
      source: sourceOf(thread.id),
      origin: null,
      provider: null,
      projectId: "",
      projectTitle: "",
      status: "idle",
      archived: false,
      updatedAt: committedAt,
      actionCount: thread.entries.filter((e) => e.type === "action").length,
      worktree: null,
      head: "",
    },
    entries: [...thread.entries],
    labels: {},
  };
}

/** When agents edited a line of a GitHub diff (`#/blame?url=…`). */
export function BlamePage({ url }: { url: string | null }) {
  const [input, setInput] = useState(url ?? "");
  const [result, setResult] = useState<BlameResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "blame · toolreader";
    setResult(null);
    setError(null);
    if (!url) return;
    call((api) => api.blame.line({ query: { url } })).then(setResult, (e: unknown) =>
      setError(errorMessage(e)),
    );
  }, [url]);

  const marks = useMemo(() => (result ? marksOf(result) : new Map<string, Mark>()), [result]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    location.hash = `#/blame?url=${encodeURIComponent(input.trim())}`;
  };
  const threads = (result?.threads ?? []).filter((t) => t.entries.some((e) => marks.has(e.id)));
  const views = useMemo(
    () => new Map(result?.threads.map((t) => [t.id, asView(t, result.commit.committedAt)])),
    [result],
  );

  return (
    <main className="viewer blame">
      <header className="topbar">
        <a href="#/">← sessions</a>
        <h1>blame</h1>
        <ThemePicker />
      </header>
      <form className="blame-form" onSubmit={submit}>
        <input
          autoFocus={!url}
          aria-label="GitHub line link"
          placeholder="Paste a line link from a GitHub PR's files (click a line number, copy the address)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button className="chip on" type="submit" disabled={!input.trim()}>
          blame
        </button>
      </form>
      {error && <div className="error">{error}</div>}
      {url && !result && !error && (
        <p className="dim">Finding the commit, its threads, and asking Jev… (a few seconds)</p>
      )}
      {result && (
        <div className="ledger">
          <section className="turn ledger-commit">
            <div className="turn-head">
              <span className="caret"> </span>
              <a
                className="sha"
                href={`${result.repoUrl}/commit/${result.commit.sha}`}
                target="_blank"
                rel="noreferrer"
              >
                {result.commit.sha.slice(0, 8)}
              </a>
              <span className="prompt">{result.commit.subject}</span>
              <span className="turn-stats">
                {fmtDay(result.commit.committedAt)} {fmtTime(result.commit.committedAt)} ·{" "}
                <code>
                  {result.path}:{result.line}
                </code>
              </span>
            </div>
            <div className="ledger-entry">
              <Snippet path={result.path} hunk={around(result.hunk, result.line)} />
              {threads.length === 0 && (
                <p className="dim">
                  No agent action touched these lines: maybe a person wrote them.
                </p>
              )}
              {threads.map((t) => (
                <details key={t.id} className="ledger-link" open>
                  <summary>
                    <span className="role coder">coder</span>{" "}
                    <a href={`#/t/${encodeURIComponent(t.id)}`} title="the whole agent history">
                      {t.title}
                    </a>
                  </summary>
                  <ActionView view={views.get(t.id)!} embedded marks={marks} />
                </details>
              ))}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

/** The lines around the blamed one. */
function Snippet({ path, hunk }: { path: string; hunk: { header: string; text: string } }) {
  const lines = hunk.text.split("\n");
  return (
    <FilePatch
      file={{
        path,
        added: lines.filter((l) => l.startsWith("+")).length,
        removed: lines.filter((l) => l.startsWith("-")).length,
        isNew: false,
        isDeleted: false,
        diff: `${hunk.header}\n${hunk.text}`,
        exactLines: true,
      }}
    />
  );
}
