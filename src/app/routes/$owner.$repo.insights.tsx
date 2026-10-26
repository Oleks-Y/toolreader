import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useState } from "react";

import type { Finding, FindingStatus } from "../../core/insights.ts";
import { fmtDay, since } from "../../web/util.ts";
import { When } from "../../web/When.tsx";
import { citeOf } from "../cite.ts";
import { nextSteps, recovery, reopened, sinceChange, TABS, tabOf, type Tab } from "../findings.ts";
import { decideFinding, runDetectors } from "../fns.ts";
import { findingsOptions, titlesOptions } from "../queries.ts";

const Search = Schema.toStandardSchemaV1(
  Schema.Struct({
    tab: Schema.optional(Schema.Literals(["open", "accepted", "rejected", "done"])),
    id: Schema.optional(Schema.String),
  }),
);

export const Route = createFileRoute("/$owner/$repo/insights")({
  validateSearch: Search,
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(findingsOptions(`${params.owner}/${params.repo}`)),
  component: Insights,
});

const DETECTOR: Record<Finding["detector"], string> = {
  "recurring-failure": "Recurring failure",
  "repeated-investigation": "Repeated investigation",
  agent: "Agent investigation",
};
/** The list's short label for each detector, in its color. */
const KIND: Record<Finding["detector"], { label: string; color: string }> = {
  "recurring-failure": { label: "failure", color: "var(--fail)" },
  "repeated-investigation": { label: "investigation", color: "var(--read)" },
  agent: { label: "agent", color: "var(--agent)" },
};
const TAB_LABEL: Record<Tab, string> = {
  open: "Open",
  accepted: "Accepted",
  rejected: "Rejected",
  done: "Done",
};
/** Citations shown before "…and N more". */
const SEEN = 4;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

function Insights() {
  const { owner, repo } = Route.useParams();
  const { tab = "open", id } = Route.useSearch();
  const full = `${owner}/${repo}`;
  const queryClient = useQueryClient();
  const { data: findings = [], error } = useQuery(findingsOptions(full));
  const detect = useMutation({
    mutationFn: () => runDetectors({ data: { repo: full } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: findingsOptions(full).queryKey }),
  });
  const shown = findings.filter((f) => tabOf(f.status) === tab);
  const selected = findings.find((f) => f.id === id) ?? shown[0];
  return (
    <div className="insights">
      <aside className="insights-list">
        <div className="insights-top">
          <div className="insights-head">
            <b>Findings</b>
            <button
              type="button"
              className="btn"
              disabled={detect.isPending}
              onClick={() => detect.mutate()}
            >
              {detect.isPending ? "Running…" : "Run detectors"}
            </button>
          </div>
          {detect.data && (
            <p className="dim">
              {detect.data.found} found, {detect.data.added} new
            </p>
          )}
          {detect.error && <div className="error">{detect.error.message}</div>}
          {error && <div className="error">{error.message}</div>}
          <nav className="insights-tabs" aria-label="Status">
            {(Object.keys(TABS) as Tab[]).map((t) => (
              <Link
                key={t}
                from={Route.fullPath}
                search={{ tab: t }}
                className={t === tab ? "on" : ""}
              >
                {TAB_LABEL[t]} · {findings.filter((f) => tabOf(f.status) === t).length}
              </Link>
            ))}
          </nav>
        </div>
        {shown.length === 0 && <p className="dim insights-empty">None.</p>}
        {shown.map((f) => {
          const outcome = recovery(f);
          return (
            <Link
              key={f.id}
              from={Route.fullPath}
              search={{ tab, id: f.id }}
              className={`finding${f.id === selected?.id ? " on" : ""}`}
            >
              <span className="hit-head">
                <span className="kind-chip" style={{ color: KIND[f.detector].color }}>
                  {KIND[f.detector].label}
                </span>
                <span className="kind-chip dim">{reopened(f) ? "reopened" : f.status}</span>
              </span>
              <span className="finding-subject">{f.subject}</span>
              <span className="dim">
                {f.detector === "repeated-investigation"
                  ? `read without edits in ${plural(f.sessions, "session")}`
                  : plural(f.sessions, "session")}
                {outcome ? ` · ${outcome.recovered} passed later` : ""} · updated{" "}
                <When at={f.updatedAt} as={since} />
              </span>
            </Link>
          );
        })}
      </aside>
      <section className="insights-detail" aria-label="Finding">
        {selected ? (
          <Detail key={selected.id} repo={full} finding={selected} />
        ) : (
          <p className="dim">No finding here. Run the detectors to look for some.</p>
        )}
      </section>
    </div>
  );
}

/** The finding's sentence, with its subject (a file or a failure) set as code. */
function Pattern({ f }: { f: Finding }) {
  const at = f.pattern.indexOf(f.subject);
  if (at === -1) return <>{f.pattern}</>;
  return (
    <>
      {f.pattern.slice(0, at)}
      <code>{f.subject}</code>
      {f.pattern.slice(at + f.subject.length)}
    </>
  );
}

function Detail({ repo, finding: f }: { repo: string; finding: Finding }) {
  const queryClient = useQueryClient();
  const [why, setWhy] = useState("");
  const [all, setAll] = useState(false);
  const navigate = Route.useNavigate();
  const decide = useMutation({
    mutationFn: (to: FindingStatus) => decideFinding({ data: { repo, id: f.id, to, why } }),
    onSuccess: async (updated) => {
      setWhy("");
      await queryClient.invalidateQueries({ queryKey: findingsOptions(repo).queryKey });
      // Follow the finding to its new tab rather than showing whichever is first in the old one.
      await navigate({ search: { tab: tabOf(updated.status), id: updated.id } });
    },
  });
  const ids = [...new Set(f.occurrences.map((o) => o.threadId))].slice(0, 50);
  const { data: titles = {} } = useQuery(titlesOptions(repo, ids));
  const back = reopened(f);
  const after = sinceChange(f);
  const outcome = recovery(f);
  const steps = nextSteps(f.status);
  const seen = all ? f.occurrences : f.occurrences.slice(0, SEEN);
  const [owner, name] = repo.split("/") as [string, string];
  return (
    <>
      <p className="dim small">
        {DETECTOR[f.detector]}
        {f.by ? ` by ${f.by}` : ""} · {f.id} · <span className="kind-chip">{f.status}</span>
      </p>
      <h2>
        <Pattern f={f} />
      </h2>
      <p>Suggestion: {f.suggestion}</p>

      {back && (
        <div className="box warn">
          <b>Rejected before</b>
          {back.rejection && (
            <p>
              <span className="dim">
                <When at={back.rejection.at} as={fmtDay} /> · {back.rejection.by}:
              </span>{" "}
              "{back.rejection.why}"
            </p>
          )}
          <p>Proposed again: {back.why}.</p>
        </div>
      )}

      {outcome && (
        <div className="box">
          <b>After the failure</b>
          <p>
            {plural(outcome.recovered, "session")} later passed the same kind of check{" "}
            <span className="dim">(what came after, not shown to be the fix)</span>
          </p>
          <p>{outcome.unresolved} with no later pass</p>
        </div>
      )}

      {after && (
        <div className="box">
          <b>Since the change</b>
          <p className="dim">
            <When at={after.change.at} as={fmtDay} /> · {after.change.by}: "{after.change.why}"
          </p>
          <p>
            Seen in {plural(after.after, "session")} since, {after.before} before.{" "}
            <span className="dim">
              Observed only: other things changed too, so this doesn't show the change worked.
            </span>
          </p>
        </div>
      )}

      {steps.length > 0 && (
        <div className="box decide">
          <b>Decide</b>
          <div className="decide-steps">
            {steps.map((s, i) => (
              <button
                key={s.to}
                type="button"
                className={`btn${i === 0 ? " primary" : ""}`}
                disabled={!why.trim() || decide.isPending}
                title={why.trim() ? undefined : "Write why first"}
                onClick={() => decide.mutate(s.to)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <label htmlFor="why" className="dim small">
            Why (kept with the finding, under your GitHub login)
          </label>
          <textarea id="why" rows={2} value={why} onChange={(e) => setWhy(e.target.value)} />
          {decide.error && <div className="error">{decide.error.message}</div>}
        </div>
      )}

      <div className="insights-cols">
        <div>
          <b>Seen in</b>
          <ul className="plain">
            {seen.map((o) => (
              <li key={`${o.threadId}#${o.entryId}`}>
                {o.entryId ? (
                  <Link
                    to="/$owner/$repo/search"
                    params={{ owner, repo: name }}
                    search={{
                      cite: citeOf(o),
                      // An agent's citation marks its own quote; a detector's, what it detected.
                      mark:
                        o.quote ??
                        (f.detector === "recurring-failure"
                          ? "failure"
                          : f.detector === "repeated-investigation"
                            ? f.subject
                            : undefined),
                    }}
                  >
                    {titles[o.threadId] || o.threadId}
                  </Link>
                ) : (
                  <span>{titles[o.threadId] || o.threadId}</span>
                )}{" "}
                <span className="dim small">
                  <When at={o.at} as={fmtDay} />
                </span>
                {o.quote && <q className="seen-quote">{o.quote}</q>}
              </li>
            ))}
          </ul>
          {f.occurrences.length > SEEN && (
            <button type="button" className="link-button dim more" onClick={() => setAll(!all)}>
              {all ? "show fewer" : `…and ${f.occurrences.length - SEEN} more`}
            </button>
          )}
        </div>
        <div>
          <b>History</b>
          <ol className="plain history">
            {[...f.events].toReversed().map((e) => (
              <li key={`${e.at}${e.to}`}>
                <span className="dim small">
                  <When at={e.at} as={fmtDay} /> · {e.by}
                </span>
                <br />
                {e.from} → {e.to}
                <br />
                <span className="dim">"{e.why}"</span>
              </li>
            ))}
            <li>
              <span className="dim small">
                <When at={f.detectedAt} as={fmtDay} /> · {f.by ?? "detector"}
              </span>
              <br />
              {f.by ? "submitted" : "detected"} ({plural(f.sessions, "session")})
            </li>
          </ol>
        </div>
      </div>
    </>
  );
}
