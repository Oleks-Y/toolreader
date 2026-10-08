import { useEffect, useMemo, useState } from "react";

import type { ThreadView } from "../core/domain.ts";
import {
  isStale,
  type LedgerCommitView,
  type LedgerLink,
  type LedgerRange,
  type LinkVia,
} from "../core/ledger.ts";
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

/** A linked thread's history as a read-only thread, so the regular viewer can render it. */
function asView(link: LedgerLink, committedAt: string): ThreadView {
  return {
    thread: {
      ...link.thread,
      projectId: "",
      projectTitle: "",
      status: "idle",
      archived: false,
      updatedAt: committedAt,
      actionCount: link.entries.filter((e) => e.type === "action").length,
      worktree: null,
      head: "",
    },
    entries: link.entries,
    labels: link.labels,
  };
}

/** How a link was found, for its tooltip. */
const VIA_TEXT: Record<LinkVia, string> = {
  asserted: "linked by hand (ledger link / review)",
  trailer: "named by the commit's Agent-Session trailer",
  sha: "its git commit printed this SHA",
  session: "named with sync --session",
  time: "its git commit ran just before this commit",
  evidence: "it edited this commit's files",
};

/**
 * Agent history per commit for a repo range, read from the agent-ledger branch. With `inline`
 * (the static page of `ledger site`) it shows that range only and never calls the server.
 */
export function LedgerPage({
  repo,
  range,
  inline,
}: {
  repo: string;
  range: string;
  inline?: LedgerRange;
}) {
  const [repos, setRepos] = useState<ReadonlyArray<{ path: string; title: string }>>([]);
  const [data, setData] = useState<LedgerRange | null>(inline ?? null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ repo, range });

  useEffect(() => {
    document.title = inline ? `${inline.range} · agent ledger` : "commit ledger · toolreader";
    if (!inline) call((api) => api.ledger.repos()).then(setRepos, () => setRepos([]));
  }, []);
  useEffect(() => {
    setDraft({ repo, range });
    if (!repo || inline) return;
    setData(null);
    setError(null);
    call((api) => api.ledger.range({ query: { repo, ...(range ? { range } : {}) } })).then(
      setData,
      (e: unknown) => setError(errorMessage(e)),
    );
  }, [repo, range]);

  const withHistory = data?.commits.filter((c) => (c.entry?.links.length ?? 0) > 0).length ?? 0;
  return (
    <main className="viewer">
      <header className="topbar">
        {!inline && <a href="#/">← sessions</a>}
        <h1>{inline ? "agent ledger" : "commit ledger"}</h1>
        <ThemePicker />
      </header>
      {!inline && (
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
      )}
      {error && <div className="error">{error}</div>}
      {repo && !data && !error && <p className="dim">loading…</p>}
      {data && (
        <p className="dim">
          {data.range} · {data.commits.length} commits · {withHistory} with agent history
          {withHistory < data.commits.length &&
            !inline &&
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
  const short = commit.sha.slice(0, 8);
  const links = entry?.links ?? [];
  const actions = links.reduce(
    (n, l) => n + l.entries.filter((e) => e.type === "action").length,
    0,
  );
  const hasHistory = links.length > 0;
  return (
    <section className={`turn ledger-commit${hasHistory ? "" : " empty"}`}>
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
          {hasHistory
            ? ` · ${links.length === 1 ? links[0]!.thread.title : `${links.length} threads`} · ${actions} actions`
            : " · no agent history"}
          {item.matchedBy === "patch-id" && " · found by patch-id (rebased)"}
        </span>
      </div>
      {open && entry && (
        <div className="ledger-entry">
          {links.map((l) => (
            <LinkRow key={l.thread.id} link={l} sha={commit.sha} committedAt={commit.committedAt} />
          ))}
          {entry.files.length > 0 && (
            <ul className="ledger-files">
              {entry.files.map((f) => (
                <li key={f.path}>
                  <span className={`bucket ${f.bucket}`}>{f.bucket}</span> <code>{f.path}</code>
                </li>
              ))}
            </ul>
          )}
          {entry.notes.map((n) => (
            <p key={`${n.at}/${n.text}`} className="ledger-note">
              note
              {n.file && (
                <>
                  {" on "}
                  <code>{n.file}</code>
                </>
              )}
              : {n.text}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

/** One linked thread: role, how it was found, and its history (open when it is the only one). */
function LinkRow({
  link,
  sha,
  committedAt,
}: {
  link: LedgerLink;
  sha: string;
  committedAt: string;
}) {
  const view = useMemo(() => asView(link, committedAt), [link, committedAt]);
  const stale = isStale(link, sha);
  return (
    <details className="ledger-link" open={link.via !== "evidence"}>
      <summary>
        <span className={`role ${link.role}`}>{link.role}</span> {link.thread.title}{" "}
        <span className="dim" title={VIA_TEXT[link.via]}>
          by {link.via}
          {link.thread.parent && " · subagent"}
          {stale && (
            <span className="stale"> · stale: reviewed {link.reviewedSha!.slice(0, 8)}</span>
          )}
        </span>
      </summary>
      {link.entries.length > 0 ? (
        <ActionView view={view} embedded />
      ) : (
        <p className="dim">no history recorded for this thread yet</p>
      )}
    </details>
  );
}
