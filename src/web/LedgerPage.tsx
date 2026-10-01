import { useEffect, useMemo, useState } from "react";

import type { ThreadView } from "../core/domain.ts";
import type { LedgerCommitView, LedgerEntry, LedgerRange } from "../core/ledger.ts";
import { ActionView } from "./ActionView.tsx";
import { call, errorMessage } from "./client.ts";
import { ThemePicker } from "./theme.tsx";
import { fmtDay, fmtTime } from "./util.ts";

/** `#/ledger?repo=…&range=…` */
export function parseLedgerHash(hash: string): { repo: string; range: string } {
  const query = new URLSearchParams(hash.split("?")[1] ?? "");
  return { repo: query.get("repo") ?? "", range: query.get("range") ?? "" };
}

const ledgerHash = (repo: string, range: string) =>
  `#/ledger?${new URLSearchParams({ repo, ...(range ? { range } : {}) }).toString()}`;

/** A ledger entry as a read-only thread, so the regular viewer can render it. */
function asView(entry: LedgerEntry): ThreadView {
  return {
    thread: {
      ...entry.thread,
      projectId: "",
      projectTitle: "",
      status: "idle",
      archived: false,
      updatedAt: entry.commit.committedAt,
      actionCount: entry.entries.filter((e) => e.type === "action").length,
      worktree: null,
      head: "",
    },
    entries: entry.entries,
    labels: entry.labels,
  };
}

/** Agent history per commit for a repo range, read from the agent-ledger branch. */
export function LedgerPage({ repo, range }: { repo: string; range: string }) {
  const [repos, setRepos] = useState<ReadonlyArray<{ path: string; title: string }>>([]);
  const [data, setData] = useState<LedgerRange | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ repo, range });

  useEffect(() => {
    document.title = "commit ledger · toolreader";
    call((api) => api.ledger.repos()).then(setRepos, () => setRepos([]));
  }, []);
  useEffect(() => {
    setDraft({ repo, range });
    if (!repo) return;
    setData(null);
    setError(null);
    call((api) => api.ledger.range({ query: { repo, ...(range ? { range } : {}) } })).then(
      setData,
      (e: unknown) => setError(errorMessage(e)),
    );
  }, [repo, range]);

  const withHistory = data?.commits.filter((c) => c.entry).length ?? 0;
  return (
    <main className="viewer">
      <header className="topbar">
        <a href="#/">← sessions</a>
        <h1>commit ledger</h1>
        <ThemePicker />
      </header>
      <form
        className="ledger-form"
        onSubmit={(e) => {
          e.preventDefault();
          location.hash = ledgerHash(draft.repo, draft.range);
        }}
      >
        <input
          list="ledger-repos"
          placeholder="Repository path"
          value={draft.repo}
          onChange={(e) => setDraft({ ...draft, repo: e.target.value })}
        />
        <datalist id="ledger-repos">
          {repos.map((r) => (
            <option key={r.path} value={r.path}>
              {r.title}
            </option>
          ))}
        </datalist>
        <input
          placeholder="Range, e.g. main..HEAD (default: default branch..HEAD)"
          value={draft.range}
          onChange={(e) => setDraft({ ...draft, range: e.target.value })}
        />
        <button className="chip on" type="submit">
          show
        </button>
      </form>
      {error && <div className="error">{error}</div>}
      {repo && !data && !error && <p className="dim">loading…</p>}
      {data && (
        <p className="dim">
          {data.range} · {data.commits.length} commits · {withHistory} with agent history
          {withHistory < data.commits.length &&
            " (run `toolreader ledger sync` to add missing ones)"}
        </p>
      )}
      <div className="ledger">
        {data?.commits.map((c) => (
          <CommitCard key={c.commit.sha} item={c} remoteUrl={data.remoteUrl} />
        ))}
      </div>
    </main>
  );
}

function CommitCard({ item, remoteUrl }: { item: LedgerCommitView; remoteUrl: string | null }) {
  const [open, setOpen] = useState(true);
  const { commit, entry } = item;
  const view = useMemo(() => (entry ? asView(entry) : null), [entry]);
  const short = commit.sha.slice(0, 8);
  return (
    <section className={`turn ledger-commit${entry ? "" : " empty"}`}>
      <div className="turn-head" onClick={() => entry && setOpen(!open)}>
        <span className="caret">{entry ? (open ? "▾" : "▸") : " "}</span>
        {remoteUrl ? (
          <a
            className="sha"
            href={`${remoteUrl}/commit/${commit.sha}`}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            {short}
          </a>
        ) : (
          <code className="sha">{short}</code>
        )}
        <span className="prompt">{commit.subject}</span>
        <span className="turn-stats">
          {fmtDay(commit.committedAt)} {fmtTime(commit.committedAt)}
          {entry ? (
            <>
              {" · "}
              {view?.thread.actionCount} actions · {entry.thread.title}
              {" · "}
              <span title="How this commit was tied to the session">
                {item.matchedBy === "patch-id"
                  ? "found by patch-id (rebased)"
                  : `matched by ${entry.match}`}
              </span>
            </>
          ) : (
            " · no agent history"
          )}
        </span>
      </div>
      {open && view && <ActionView view={view} embedded />}
    </section>
  );
}
