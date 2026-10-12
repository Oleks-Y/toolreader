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
import { ThemePicker } from "./theme.tsx";
import { fmtDay, fmtTime } from "./util.ts";

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
  asserted: "linked by hand",
  trailer: "named by the commit's Agent-Session trailer",
  sha: "its git commit printed this SHA",
  session: "named by hand",
  time: "its git commit ran just before this commit",
  evidence: "it edited this commit's files",
  content: "its edits wrote this commit's new lines",
};

/**
 * Agent history per commit for a range: the static page `history site` writes, with the range
 * inlined. It never calls a server.
 */
export function LedgerPage({ data }: { data: LedgerRange }) {
  useEffect(() => {
    document.title = `${data.range} · agent history`;
  }, []);
  const withHistory = data.commits.filter((c) => (c.entry?.links.length ?? 0) > 0).length;
  return (
    <main className="viewer">
      <header className="topbar">
        <h1>agent history</h1>
        <ThemePicker />
      </header>
      <p className="dim">
        {data.range} · {data.commits.length} commits · {withHistory} with agent history
      </p>
      <div className="ledger">
        {data.commits.map((c) => (
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
            <LinkRow
              key={`${l.thread.id}/${l.role}`}
              link={l}
              sha={commit.sha}
              committedAt={commit.committedAt}
            />
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

/** One linked thread: role, how it was found, and its history (evidence links start closed). */
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
  // History mounts only while open: FileDiff measures against the window and renders blank hidden.
  const [open, setOpen] = useState(link.via !== "evidence");
  return (
    <details className="ledger-link" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
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
      {!open ? null : link.entries.length > 0 ? (
        <ActionView view={view} embedded />
      ) : (
        <p className="dim">no history recorded for this thread yet</p>
      )}
    </details>
  );
}
