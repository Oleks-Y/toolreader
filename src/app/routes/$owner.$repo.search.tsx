import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";

import { ACTION_KINDS, type ActionKind } from "../../core/domain.ts";
import type { Evidence } from "../../core/historyApi.ts";
import { fmtTime, since } from "../../web/util.ts";
import { citeOf, parseCite, type Cite } from "../cite.ts";
import { citationOptions, searchOptions } from "../queries.ts";

const Search = Schema.toStandardSchemaV1(
  Schema.Struct({
    q: Schema.optional(Schema.String),
    /** A commit SHA or prefix: only sessions linked to it. */
    commit: Schema.optional(Schema.String),
    /** Action kinds, comma-separated: only those actions. */
    kinds: Schema.optional(Schema.String),
    cite: Schema.optional(Schema.String),
  }),
);

export const Route = createFileRoute("/$owner/$repo/search")({
  validateSearch: Search,
  component: SearchPage,
});

const SHA = /^[0-9a-f]{4,64}$/;
const kindsOf = (s: string | undefined): ActionKind[] =>
  (s ?? "")
    .split(",")
    .filter((k): k is ActionKind => (ACTION_KINDS as readonly string[]).includes(k));

/** Steps shown on each side of the cited one in "The turn around it". */
const AROUND = 3;

/** A kind's color, as the viewer's themes give each action kind one. */
const tone = (kind: string, status?: string) =>
  status === "failed" ? "var(--fail)" : `var(--${kind === "edit" ? "write" : kind}, var(--dim))`;

/** Terminal color codes, which outputs keep and a plain block would show as text. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[\\d;]*[A-Za-z]`, "g");

/** `text` without color codes, each case-insensitive occurrence of `q` marked. */
function marked(raw: string, q: string): ReactNode {
  const text = raw.replace(ANSI, "");
  if (!q) return text;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const out: ReactNode[] = [];
  let at = 0;
  for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, at)) {
    out.push(text.slice(at, i), <mark key={i}>{text.slice(i, i + q.length)}</mark>);
    at = i + q.length;
  }
  out.push(text.slice(at));
  return out;
}

function SearchPage() {
  const { owner, repo } = Route.useParams();
  const { q, commit, kinds: kindParam, cite } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [input, setInput] = useState(q ?? "");
  const [commitInput, setCommitInput] = useState(commit ?? "");
  const full = `${owner}/${repo}`;
  const text = q?.trim() ?? "";
  const sha = commit && SHA.test(commit) ? commit : undefined;
  const kinds = kindsOf(kindParam);
  const filtered = sha !== undefined || kinds.length > 0;
  const { data, error, isFetching } = useQuery({
    ...searchOptions(full, { text: text || undefined, commit: sha, kinds }),
    enabled: text.length >= 2 || filtered,
  });
  const selected = cite ? parseCite(cite) : null;
  const typedSha = commitInput.trim().toLowerCase();
  const badSha = typedSha !== "" && !SHA.test(typedSha);
  const toggle = (k: ActionKind) => {
    const next = kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k];
    navigate({
      search: (s) => ({ ...s, kinds: next.length ? next.join(",") : undefined, cite: undefined }),
    });
  };
  return (
    <div className="search">
      <aside className="search-side">
        <form
          role="search"
          className="search-form"
          onSubmit={(e) => {
            e.preventDefault();
            const t = input.trim();
            if (badSha || t.length === 1) return;
            navigate({
              search: (s) => ({
                ...s,
                q: t || undefined,
                commit: typedSha || undefined,
                cite: undefined,
              }),
            });
          }}
        >
          <label htmlFor="search-q" className="dim">
            Search this repo's sessions
          </label>
          <input
            id="search-q"
            placeholder="An error, a command, a path…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <div className="search-filters">
            <label htmlFor="search-commit" className="dim">
              In commit
            </label>
            <input
              id="search-commit"
              className={`search-commit${badSha ? " bad" : ""}`}
              placeholder="any · SHA or prefix"
              value={commitInput}
              onChange={(e) => setCommitInput(e.target.value)}
              aria-invalid={badSha}
            />
            {commit && (
              <button
                type="button"
                className="link-button dim"
                onClick={() => {
                  setCommitInput("");
                  navigate({ search: (s) => ({ ...s, commit: undefined, cite: undefined }) });
                }}
              >
                clear
              </button>
            )}
            {/* Enter in either field searches; this keeps the form submittable without one. */}
            <button type="submit" hidden />
          </div>
          {badSha && <span className="error">A commit is 4–64 hex characters.</span>}
          <div className="search-kinds" role="group" aria-label="Operation types">
            {ACTION_KINDS.map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={kinds.includes(k)}
                className={`kind-chip toggle${kinds.includes(k) ? " on" : ""}`}
                style={{ color: tone(k) }}
                onClick={() => toggle(k)}
              >
                {k}
              </button>
            ))}
          </div>
          <span className="dim">
            {isFetching
              ? "searching…"
              : data
                ? `${data.hits.length} hit${data.hits.length === 1 ? "" : "s"}, newest first${data.truncated ? " · more matched" : ""}`
                : "Commands, outputs, messages and paths, in sessions linked to this repo's commits"}
          </span>
        </form>
        {error && <div className="error">{error.message}</div>}
        {data?.hits.length === 0 && <p className="dim search-empty">Nothing found.</p>}
        {data?.hits.map((h) => (
          <Link
            key={citeOf(h)}
            className={`search-hit${cite === citeOf(h) ? " on" : ""}`}
            from={Route.fullPath}
            search={(s) => ({ ...s, cite: citeOf(h) })}
          >
            <span className="hit-head">
              <span
                className="kind-chip"
                style={{ color: h.type === "message" ? undefined : tone(h.kind, h.status) }}
              >
                {h.type === "message" ? "message" : h.kind} · {h.status ?? h.kind}
              </span>
              <span className="dim">{since(h.at)}</span>
            </span>
            <b className="hit-title">{h.threadTitle || h.threadId}</b>
            {h.snippet && (
              <span className={`hit-snippet${h.type === "action" ? " mono" : ""}`}>
                {marked(h.snippet, text)}
              </span>
            )}
          </Link>
        ))}
      </aside>
      <section className="search-cited" aria-label="Citation">
        {selected ? (
          <Cited repo={full} cite={selected} q={text} />
        ) : (
          <p className="dim">
            {data
              ? "Pick a hit to read the entry it cites."
              : "Search for an error, a command or a path, or pick a commit or an operation type."}
          </p>
        )}
      </section>
    </div>
  );
}

/** An entry's text with the search marked, scrolled to its first match. */
function Body({ text, q, prose }: { text: string; q: string; prose?: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const mark = ref.current?.querySelector("mark");
    if (ref.current && mark) ref.current.scrollTop = mark.offsetTop - 40;
  }, [text, q]);
  return (
    <pre ref={ref} className={`cited-body${prose ? " prose" : ""}`}>
      {marked(text, q)}
    </pre>
  );
}

/** Why a citation can't be read, in the reader's terms. */
const UNREADABLE: Record<Exclude<Evidence["status"], "ok">, string> = {
  "version-unavailable": "changed since",
  withheld: "not yours to read",
  deleted: "removed on request",
  expired: "expired",
  missing: "never stored here",
};
const UNREADABLE_WHY: Record<Exclude<Evidence["status"], "ok">, string> = {
  "version-unavailable":
    "The session was replaced since this hit was found; the entry may say something else now.",
  withheld: "This session isn't linked to this repo's commits.",
  deleted: "The session was deleted on request.",
  expired: "The session is past the retention period.",
  missing: "The backend never stored this session.",
};

function Cited({ repo, cite, q }: { repo: string; cite: Cite; q: string }) {
  const { data, error, isFetching } = useQuery(citationOptions(repo, cite));
  const [copied, setCopied] = useState(false);
  if (isFetching && !data) return <p className="dim">reading…</p>;
  if (error) return <div className="error">{error.message}</div>;
  if (!data) return null;
  const ref = (
    <span className="mono dim">
      {cite.threadId}#{cite.entryId}
      {cite.version ? `@${cite.version.slice(0, 8)}` : ""}
      {data.turn ? ` · turn ${data.turn.n}` : ""}
      {data.entry ? ` · ${fmtTime(data.entry.at)}` : ""}
    </span>
  );
  if (data.status !== "ok" || !data.entry) {
    const status = data.status === "ok" ? "missing" : data.status;
    return (
      <>
        <div className="cited-head">
          <span className="dim">
            Citation · <span style={{ color: "var(--write)" }}>{UNREADABLE[status]}</span>
          </span>
          {ref}
        </div>
        <p>{UNREADABLE_WHY[status]}</p>
        {status === "version-unavailable" && (
          <Link
            from={Route.fullPath}
            search={(s) => ({
              ...s,
              cite: citeOf({ threadId: cite.threadId, entryId: cite.entryId }),
            })}
            className="btn"
          >
            See it now
          </Link>
        )}
      </>
    );
  }
  const e = data.entry;
  const steps = data.turn?.steps ?? [];
  // A message isn't a step: place it before the first step after it.
  const byId = steps.findIndex((s) => s.id === e.id);
  const after = steps.findIndex((s) => s.at > e.at);
  const at = byId !== -1 ? byId : after === -1 ? steps.length : after;
  const from = Math.max(0, at - AROUND);
  const to = Math.min(steps.length, at + AROUND + 1);
  return (
    <>
      <div className="cited-top">
        <div className="cited-head">
          <span className="dim">
            Citation · <span style={{ color: "var(--test)" }}>readable at this version</span>
          </span>
          <h2>{data.title || cite.threadId}</h2>
          {ref}
        </div>
        <button
          type="button"
          className="btn"
          onClick={() =>
            navigator.clipboard.writeText(window.location.href).then(() => setCopied(true))
          }
        >
          {copied ? "Copied" : "Copy citation"}
        </button>
      </div>

      {e.type === "action" ? (
        <div className="cited-entry" style={{ borderColor: tone(e.kind, e.status) }}>
          <div className="cited-entry-head">
            <span className="kind-chip" style={{ color: tone(e.kind, e.status) }}>
              {e.kind} · {e.exitCode === undefined ? e.status : `exit ${e.exitCode}`}
            </span>
            <code className="mono">{e.command ?? e.title}</code>
          </div>
          {e.output && <Body text={e.output} q={q} />}
          {(e.files ?? []).map((f) => (
            <p key={f.path} className="mono cited-file">
              {f.path}{" "}
              <span className="dim">
                +{f.added} −{f.removed}
              </span>
            </p>
          ))}
        </div>
      ) : e.type === "message" ? (
        <div className="cited-entry">
          <div className="cited-entry-head">
            <span className="kind-chip">message · {e.role}</span>
          </div>
          <Body text={e.text} q={q} prose />
        </div>
      ) : (
        <div className="cited-entry">
          <Body text={e.text} q={q} />
        </div>
      )}

      {data.turn && steps.length > 0 && (
        <details open className="cited-turn">
          <summary>
            The turn around it · {steps.length} step{steps.length === 1 ? "" : "s"}
          </summary>
          {data.turn.prompt && <p className="dim">“{data.turn.prompt}”</p>}
          {from > 0 && <p className="dim">{from} earlier</p>}
          <ol start={from + 1}>
            {steps.slice(from, to).map((s, i) => (
              <Fragment key={s.id}>
                {byId === -1 && from + i === at && <li className="this mark-row">this message</li>}
                <li className={s.id === e.id ? "this" : ""}>
                  <span style={{ color: tone(s.kind, s.status) }}>
                    {s.kind}
                    {s.status === "failed" ? " ✗" : ""}
                  </span>{" "}
                  <span className="mono">{s.title}</span>
                  {s.added + s.removed > 0 && (
                    <span className="dim">
                      {" "}
                      · +{s.added} −{s.removed}
                    </span>
                  )}
                  {s.id === e.id && " (this entry)"}
                </li>
              </Fragment>
            ))}
            {byId === -1 && at === to && <li className="this mark-row">this message</li>}
          </ol>
          {to < steps.length && <p className="dim">{steps.length - to} later</p>}
        </details>
      )}
    </>
  );
}
