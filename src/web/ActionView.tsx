import { useCallback, useEffect, useMemo, useState } from "react";
import {
  buildTree,
  DEFAULT_SWITCHES,
  type Fold,
  type Item,
  type Phase,
  type Switches,
  type Turn,
} from "../core/tree.ts";
import {
  ACTION_KINDS,
  type Action,
  type ActionKind,
  type Event,
  type FileChange,
  type Labels,
  type Message,
  type ThreadView,
} from "../core/domain.ts";
import { proofFileName, type ProofArtifact, type ProofScope } from "../core/proof.ts";
import { call, errorMessage } from "./client.ts";
import { Swimlane, type Range } from "./Swimlane.tsx";
import { ThemePicker } from "./theme.tsx";
import { CommandBlock, FilePatch, Markdown, OutputBlock } from "./code.tsx";
import { langFromPath } from "./codeLang.ts";
import { fmtDay, fmtDuration, fmtTime } from "./util.ts";

type Prefs = Switches & { labels: boolean };
const PREFS_KEY = "toolreader.switches";

function loadPrefs(): Prefs {
  const defaults: Prefs = { ...DEFAULT_SWITCHES, labels: true };
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    return { ...defaults, ...saved, kinds: { ...defaults.kinds, ...saved.kinds } };
  } catch {
    return defaults;
  }
}

const ICON: Record<ActionKind, string> = {
  read: "◎",
  search: "⌕",
  edit: "✎",
  git: "⎇",
  docker: "◆",
  setup: "⇣",
  build: "⚒",
  run: "▶",
  test: "✔",
  web: "◍",
  tool: "⚙",
  agent: "⧉",
};

/** Kinds whose second word is a subcommand worth coloring too: `git diff`, `go test`, `docker compose`. */
const COLOR_SUBCOMMAND = new Set<ActionKind>(["git", "docker", "setup", "build", "run", "test"]);

/** Style A: the command word(s) in the kind's color, the rest muted. */
function CommandPart({ kind, title }: { kind: ActionKind; title: string }) {
  // MCP calls read "server · tool {args}": color the server and tool, mute the arguments.
  const mcp = kind === "tool" ? /^(\S+ · \S+)(.*)$/s.exec(title) : null;
  if (mcp) {
    return (
      <span className={`k-${kind}`}>
        <span className="cmd-word">{mcp[1]}</span>
        {mcp[2]}
      </span>
    );
  }
  const [first = "", second, ...rest] = title.split(" ");
  const colorSecond =
    second !== undefined && COLOR_SUBCOMMAND.has(kind) && /^[a-z][\w:-]*$/.test(second);
  return (
    <span className={`k-${kind}`}>
      <span className="cmd-word">{first}</span>
      {second !== undefined && " "}
      {colorSecond ? <span className="cmd-word">{second}</span> : second}
      {rest.length > 0 && ` ${rest.join(" ")}`}
    </span>
  );
}
const PHASE_LABEL: Record<Phase["name"], string> = {
  explore: "Explore",
  edit: "Edit",
  verify: "Verify",
  fix: "Fix",
  ship: "Ship",
  all: "",
};

/** Open/closed state: ids in `flipped` invert their default. */
function useOpenState() {
  const [flipped, setFlipped] = useState<Set<string>>(new Set());
  const isOpen = useCallback(
    (id: string, byDefault: boolean) => byDefault !== flipped.has(id),
    [flipped],
  );
  const toggle = useCallback(
    (id: string) =>
      setFlipped((s) => {
        const n = new Set(s);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      }),
    [],
  );
  const force = useCallback(
    (open: Array<[string, boolean]>) =>
      setFlipped((s) => {
        const n = new Set(s);
        for (const [id, byDefault] of open) {
          if (byDefault) n.delete(id);
          else n.add(id);
        }
        return n;
      }),
    [],
  );
  return { isOpen, toggle, force, reset: (ids: string[] = []) => setFlipped(new Set(ids)) };
}

type Ctx = {
  labels: Labels;
  showLabels: boolean;
  open: ReturnType<typeof useOpenState>;
  highlight: string | null;
};

/** Download link for a proof-of-work artifact of the whole thread, some turns, or a time range. */
function proofLink(view: ThreadView, scope: ProofScope) {
  const query = new URLSearchParams();
  if (scope.turns) query.set("turns", `${scope.turns.from}-${scope.turns.to}`);
  if (scope.range) {
    query.set("from", scope.range.from);
    query.set("to", scope.range.to);
  }
  const qs = query.toString();
  return {
    href: `/api/threads/${encodeURIComponent(view.thread.id)}/proof${qs ? `?${qs}` : ""}`,
    download: proofFileName(view, scope),
  };
}

/**
 * A live thread (`threadId`, fetched and polled), a proof-of-work file (`artifact`), or a given
 * `view` (ledger entries). Without `threadId` it is read-only: no polling, labeling or export.
 * `embedded` renders only the turn tree, for pages that show several histories.
 */
export function ActionView({
  threadId,
  artifact,
  view: givenView,
  embedded = false,
}: {
  threadId?: string;
  artifact?: ProofArtifact;
  view?: ThreadView;
  embedded?: boolean;
}) {
  const readOnly = threadId === undefined;
  const [view, setView] = useState<ThreadView | null>(artifact?.view ?? givenView ?? null);
  const [error, setError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [range, setRange] = useState<Range | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [labeling, setLabeling] = useState<Record<string, string>>({}); // turnId → status text
  const open = useOpenState();

  const load = useCallback(
    () =>
      threadId === undefined
        ? Promise.resolve()
        : call((api) => api.threads.get({ params: { id: threadId } })).then(setView, (e: unknown) =>
            setError(errorMessage(e)),
          ),
    [threadId],
  );
  useEffect(() => void load(), [load]);
  useEffect(() => localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)), [prefs]);
  useEffect(() => {
    if (view && !embedded) document.title = `${view.thread.title} · toolreader`;
  }, [view?.thread.title]);

  // ponytail: polls a cheap head marker while running; switch to a push stream if this ever matters.
  const running = view?.thread.status === "running";
  const head = view?.thread.head;
  useEffect(() => {
    if (!running || threadId === undefined) return;
    const timer = setInterval(async () => {
      const h = await call((api) => api.threads.head({ params: { id: threadId } })).catch(
        () => null,
      );
      if (h && h.head !== head) load();
    }, 3000);
    return () => clearInterval(timer);
  }, [running, head, threadId, load]);

  const actions = useMemo(
    () => (view?.entries ?? []).filter((e): e is Action => e.type === "action"),
    [view],
  );
  const turns = useMemo(
    () => (view ? buildTree(view.entries, prefs, range) : []),
    [view, prefs, range],
  );
  const turnStarts = useMemo(
    () => turns.map((t) => t.prompt?.at ?? t.stats.start).filter(Boolean),
    [turns],
  );
  const kindCounts = useMemo(() => {
    const c = Object.fromEntries(ACTION_KINDS.map((k) => [k, 0])) as Record<ActionKind, number>;
    for (const a of actions) c[a.kind]++;
    return c;
  }, [actions]);
  const hiddenKinds = useMemo(
    () => new Set(ACTION_KINDS.filter((k) => !prefs.kinds[k])),
    [prefs.kinds],
  );

  const pick = (id: string) => {
    for (const t of turns)
      for (const p of t.phases)
        for (const item of p.items) {
          const inFold = item.type === "fold" && item.actions.some((a) => a.id === id);
          if (item.id !== id && !inFold) continue;
          open.force([
            [t.id, true],
            [p.id, true],
            ...(inFold ? ([[item.id, false]] as Array<[string, boolean]>) : []),
          ]);
          setHighlight(id);
          requestAnimationFrame(() =>
            document.getElementById(`row-${id}`)?.scrollIntoView({ block: "center" }),
          );
          return;
        }
  };

  const labelTurn = async (turn: Turn) => {
    if (!view || threadId === undefined) return;
    const items = turn.phases
      .flatMap((p) => p.items)
      .flatMap((item) => labelItem(item, view.labels))
      .slice(0, 150);
    if (!items.length) return setLabeling((s) => ({ ...s, [turn.id]: "nothing new to label" }));
    setLabeling((s) => ({ ...s, [turn.id]: `labeling ${items.length}…` }));
    try {
      const labels = await call((api) =>
        api.labels.create({
          payload: { threadId, context: turn.prompt?.text ?? view.thread.title, items },
        }),
      );
      setView((v) => (v ? { ...v, labels } : v));
      setLabeling((s) => ({ ...s, [turn.id]: "" }));
    } catch (e) {
      setLabeling((s) => ({ ...s, [turn.id]: `failed: ${errorMessage(e)}` }));
    }
  };

  const back = artifact ? <a href="#/file">← open another file</a> : <a href="#/">← sessions</a>;
  if (error)
    return (
      <main className="viewer">
        {back}
        <div className="error">{error}</div>
      </main>
    );
  if (!view)
    return (
      <main className="viewer">
        {back}
        <p className="dim">loading…</p>
      </main>
    );

  const t = view.thread;
  const total = turns.reduce(
    (s, x) => ({
      files: s.files + x.stats.files,
      added: s.added + x.stats.added,
      removed: s.removed + x.stats.removed,
      failed: s.failed + x.stats.failed,
    }),
    { files: 0, added: 0, removed: 0, failed: 0 },
  );
  const set = (patch: Partial<Prefs>) => setPrefs((p) => ({ ...p, ...patch }));
  const ctx: Ctx = { labels: view.labels, showLabels: prefs.labels, open, highlight };
  const tree = (
    <div className="tree">
      {turns.map((turn, i) => (
        <TurnBlock
          key={turn.id}
          turn={turn}
          prevDay={i > 0 ? fmtDay(turns[i - 1]!.stats.start) : ""}
          ctx={ctx}
          labeling={labeling[turn.id]}
          onLabel={readOnly ? undefined : () => labelTurn(turn)}
          exportLink={
            readOnly
              ? undefined
              : proofLink(view, {
                  turns: { from: turn.index + 1, to: turn.index + 1 },
                  range: null,
                })
          }
        />
      ))}
      {turns.length === 0 && <p className="dim">No entries.</p>}
    </div>
  );
  if (embedded) return tree;

  return (
    <main className="viewer">
      <header className="thread-head">
        {back}
        <h1>{t.title}</h1>
        <span className={`status-dot ${t.status}`} title={t.status} />
        <span className="dim">
          {t.projectTitle} · {t.source === "t3" ? `t3 · ${t.provider}` : (t.origin ?? t.source)} ·{" "}
          {actions.length} actions · {total.files} files <span className="add">+{total.added}</span>{" "}
          <span className="del">−{total.removed}</span>
          {total.failed > 0 && <span className="fail"> · {total.failed} failed</span>}
        </span>
        {artifact ? (
          <span className="proof-meta">
            proof · exported {fmtDay(artifact.exportedAt)} {fmtTime(artifact.exportedAt)}
            {artifact.git?.branch && ` · ${artifact.git.branch}`}
            {artifact.git?.head && `@${artifact.git.head.slice(0, 8)}`} · outputs {artifact.outputs}
            {artifact.redactions > 0 && ` · ${artifact.redactions} redacted`}
          </span>
        ) : (
          <a className="chip" {...proofLink(view, { turns: null, range: null })}>
            ⇩ export
          </a>
        )}
      </header>

      <div className="toolbar">
        <ThemePicker />
        <span className="sep" />
        {ACTION_KINDS.map((k) => (
          <button
            key={k}
            className={`chip k-${k}${prefs.kinds[k] ? " on" : ""}`}
            onClick={() => set({ kinds: { ...prefs.kinds, [k]: !prefs.kinds[k] } })}
          >
            {ICON[k]} {k} <span className="dim">{kindCounts[k]}</span>
          </button>
        ))}
        <span className="sep" />
        {(
          [
            ["notes", "notes"],
            ["reasoning", "reasoning"],
            ["failuresOnly", "failures only"],
            ["foldReads", "fold reads"],
            ["phases", "phases"],
            ["labels", "codex labels"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="switch">
            <input
              type="checkbox"
              checked={prefs[key]}
              onChange={(e) => set({ [key]: e.target.checked })}
            />{" "}
            {label}
          </label>
        ))}
        <span className="sep" />
        <button className="chip" onClick={() => open.reset()}>
          expand turns
        </button>
        <button className="chip" onClick={() => open.reset(turns.map((x) => x.id))}>
          collapse turns
        </button>
        {range && (
          <button className="chip on range-chip" onClick={() => setRange(null)}>
            {fmtTime(range.from)}–{fmtTime(range.to)} ✕
          </button>
        )}
        {range && !artifact && (
          <a className="chip on range-chip" {...proofLink(view, { turns: null, range })}>
            ⇩ export range
          </a>
        )}
      </div>

      <Swimlane
        actions={actions}
        turnStarts={turnStarts}
        hiddenKinds={hiddenKinds}
        range={range}
        onRange={setRange}
        onPick={pick}
      />
      <p className="hint dim">
        Drag across the lanes to filter by time · double-click to clear · click a dot to jump to it
      </p>

      {tree}
    </main>
  );
}

function labelItem(item: Item, labels: Labels): Array<{ id: string; text: string }> {
  if (labels[item.id]) return [];
  const clip = (s: string) => (s.length > 600 ? `${s.slice(0, 600)}…` : s);
  if (item.type === "fold")
    return [
      {
        id: item.id,
        text: clip(`explored (${item.summary}): ${item.actions.map((a) => a.title).join("; ")}`),
      },
    ];
  if (item.type !== "action") return [];
  const parts = [item.title];
  if (item.command && item.command !== item.title) parts.push(`command: ${item.command}`);
  if (item.hint) parts.push(`agent's note: ${item.hint}`);
  if (item.files?.length)
    parts.push(`files: ${item.files.map((f) => `${f.path} +${f.added} -${f.removed}`).join(", ")}`);
  if (item.status === "failed")
    parts.push(
      `FAILED${item.exitCode !== undefined ? ` exit ${item.exitCode}` : ""}: ${(item.output ?? "").slice(-200)}`,
    );
  return [{ id: item.id, text: clip(parts.join(" | ")) }];
}

function TurnBlock({
  turn,
  prevDay,
  ctx,
  labeling,
  onLabel,
  exportLink,
}: {
  turn: Turn;
  prevDay: string;
  ctx: Ctx;
  labeling?: string | undefined;
  /** Absent for proof files, which are read-only. */
  onLabel: (() => void) | undefined;
  exportLink: { href: string; download: string } | undefined;
}) {
  const isOpen = ctx.open.isOpen(turn.id, true);
  const s = turn.stats;
  const day = fmtDay(s.start);
  return (
    <section className="turn">
      <div className="turn-head" onClick={() => ctx.open.toggle(turn.id)}>
        <span className="caret">{isOpen ? "▾" : "▸"}</span>
        <span className="turn-index">T{turn.index + 1}</span>
        <span className="prompt">
          {turn.prompt ? turn.prompt.text : <i className="dim">(no prompt)</i>}
        </span>
        <span className="turn-stats">
          {day !== prevDay && <b>{day} </b>}
          {fmtTime(s.start)} · {fmtDuration(Date.parse(s.end) - Date.parse(s.start))} · {s.actions}{" "}
          actions
          {s.files > 0 && (
            <>
              {" "}
              · {s.files} files <span className="add">+{s.added}</span>{" "}
              <span className="del">−{s.removed}</span>
            </>
          )}
          {s.failed > 0 && <span className="fail"> · {s.failed} failed</span>}
        </span>
        {exportLink && (
          <a className="chip" {...exportLink} onClick={(e) => e.stopPropagation()}>
            ⇩ export
          </a>
        )}
        {onLabel && (
          <button
            className="chip label-btn"
            onClick={(e) => {
              e.stopPropagation();
              onLabel();
            }}
            disabled={!!labeling?.startsWith("labeling")}
          >
            {labeling || "✨ Label with Codex"}
          </button>
        )}
      </div>
      {isOpen && turn.phases.map((p) => <PhaseBlock key={p.id} phase={p} ctx={ctx} />)}
    </section>
  );
}

function PhaseBlock({ phase, ctx }: { phase: Phase; ctx: Ctx }) {
  const isOpen = ctx.open.isOpen(phase.id, true);
  const items = phase.items.map((item) => <ItemRow key={item.id} item={item} ctx={ctx} />);
  if (phase.name === "all") return <div className="phase-body">{items}</div>;
  const count = phase.items.reduce(
    (n, i) => n + (i.type === "fold" ? i.actions.length : i.type === "action" ? 1 : 0),
    0,
  );
  const failed = phase.items.filter((i) => i.type === "action" && i.status === "failed").length;
  return (
    <div className={`phase phase-${phase.name}`}>
      <div className="phase-head" onClick={() => ctx.open.toggle(phase.id)}>
        <span className="caret">{isOpen ? "▾" : "▸"}</span>
        <b>{PHASE_LABEL[phase.name]}</b>
        <span>
          {fmtTime(phase.start)}–{fmtTime(phase.end)} ·{" "}
          {fmtDuration(Date.parse(phase.end) - Date.parse(phase.start))} · {count} actions
          {failed > 0 && <span className="fail"> · {failed} failed</span>}
        </span>
        <span className="bar" />
      </div>
      {isOpen && <div className="phase-body">{items}</div>}
    </div>
  );
}

function ItemRow({ item, ctx }: { item: Item; ctx: Ctx }) {
  if (item.type === "action") return <ActionRow action={item} ctx={ctx} />;
  if (item.type === "fold") return <FoldRow fold={item} ctx={ctx} />;
  if (item.type === "message") return <MessageRow message={item} ctx={ctx} />;
  return <EventRow event={item} />;
}

function Title({ id, title, ctx }: { id: string; title: React.ReactNode; ctx: Ctx }) {
  const label = ctx.showLabels ? ctx.labels[id] : undefined;
  if (!label) return <span className="title">{title}</span>;
  return (
    <span className="title">
      <span className="label">{label}</span> <span className="orig">{title}</span>
    </span>
  );
}

function Path({ path }: { path: string }) {
  const i = path.lastIndexOf("/");
  return (
    <span className="path">
      {i > 0 && <span className="dir">{path.slice(0, i + 1)}</span>}
      {path.slice(i + 1)}
    </span>
  );
}

function FileStat({ f }: { f: FileChange }) {
  if (f.isNew) return <span className="badge new">new</span>;
  if (f.isDeleted) return <span className="badge del">deleted</span>;
  return (
    <>
      {f.added > 0 && <span className="add">+{f.added}</span>}{" "}
      {f.removed > 0 && <span className="del">−{f.removed}</span>}
    </>
  );
}

function ActionRow({ action: a, ctx, compact }: { action: Action; ctx: Ctx; compact?: boolean }) {
  const isOpen = ctx.open.isOpen(a.id, false);
  const files = a.files ?? [];
  const title =
    a.kind === "edit" && files.length > 0 ? (
      <>
        {files.slice(0, 3).map((f) => (
          <span key={f.path} className="file-inline">
            <Path path={f.path} /> <FileStat f={f} />
          </span>
        ))}
        {files.length > 3 && <span className="dim"> +{files.length - 3} more</span>}
      </>
    ) : (
      (a.parts ?? [{ kind: a.kind, title: a.title }]).map((p, i) => (
        // oxlint-disable-next-line react/no-array-index-key -- parts are a fixed, ordered split of one command
        <span key={i}>
          {i > 0 && <span className="part-sep"> · </span>}
          <CommandPart kind={p.kind} title={p.title} />
        </span>
      ))
    );
  const right =
    a.status === "failed" ? (
      <span className="fail">{a.exitCode !== undefined ? `exit ${a.exitCode}` : "failed"}</span>
    ) : a.status === "running" ? (
      <span className="dim">running</span>
    ) : a.noMatch ? (
      <span className="dim">no match</span>
    ) : null;
  return (
    <div id={`row-${a.id}`} className={`row-wrap${ctx.highlight === a.id ? " highlight" : ""}`}>
      <div
        className={`row action k-${a.kind} ${a.status}${compact ? " compact" : ""}`}
        onClick={() => ctx.open.toggle(a.id)}
      >
        <span className="t">{compact ? "" : fmtTime(a.at)}</span>
        <span className={`icon k-${a.kind}`}>{a.status === "failed" ? "✗" : ICON[a.kind]}</span>
        <span className="main">
          <Title id={a.id} title={title} ctx={ctx} />
          {a.hint && a.kind !== "agent" && <span className="hint-text"> — {a.hint}</span>}
        </span>
        <span className="r">{right}</span>
      </div>
      {isOpen && <ActionDetail a={a} />}
    </div>
  );
}

function ActionDetail({ a }: { a: Action }) {
  // A single-file read shows that file's contents: highlight them in its language.
  const readTarget = a.kind === "read" && a.targets?.length === 1 ? a.targets[0] : undefined;
  return (
    <div className="detail">
      {a.kind === "agent" && a.hint && <Markdown text={a.hint} highlight />}
      {a.command && <CommandBlock command={a.command} />}
      {(a.files ?? []).map((f) => (
        <div key={f.path} className="file-diff">
          <div className="file-head">
            <Path path={f.path} /> <FileStat f={f} />
            {f.truncated && <span className="dim"> · large diff, showing the first hunks</span>}
          </div>
          {f.diff && <FilePatch file={{ ...f, diff: f.diff }} />}
        </div>
      ))}
      {a.output && (
        <OutputBlock
          text={a.output}
          hint={readTarget ? langFromPath(readTarget) : undefined}
          failed={a.status === "failed"}
        />
      )}
    </div>
  );
}

function FoldRow({ fold, ctx }: { fold: Fold; ctx: Ctx }) {
  const isOpen = ctx.open.isOpen(fold.id, false);
  const shown = fold.targets.slice(0, 5);
  return (
    <div className="row-wrap">
      <div className="row fold" onClick={() => ctx.open.toggle(fold.id)}>
        <span className="t">{fmtTime(fold.at)}</span>
        <span className="icon k-read">{isOpen ? "▾" : "◎"}</span>
        <span className="main">
          <Title
            id={fold.id}
            ctx={ctx}
            title={
              <>
                <span className="k-read">
                  <span className="cmd-word">explored</span>
                </span>{" "}
                {fold.summary}
                {shown.length > 0 && <span className="dim"> · </span>}
                {shown.map((p, i) => (
                  <span key={p}>
                    {i > 0 && <span className="dim">, </span>}
                    <Path path={p} />
                  </span>
                ))}
                {fold.targets.length > shown.length && (
                  <span className="dim"> +{fold.targets.length - shown.length}</span>
                )}
              </>
            }
          />
        </span>
        <span className="r dim">
          {fmtDuration(Date.parse(fold.actions.at(-1)!.at) - Date.parse(fold.at))}
        </span>
      </div>
      {isOpen && (
        <div className="fold-body">
          {fold.actions.map((a) => (
            <ActionRow key={a.id} action={a} ctx={ctx} compact />
          ))}
        </div>
      )}
    </div>
  );
}

function MessageRow({ message: m, ctx }: { message: Message; ctx: Ctx }) {
  const isOpen = ctx.open.isOpen(m.id, false);
  return (
    <div
      className={`row message ${m.role}${isOpen ? " open" : ""}`}
      onClick={() => ctx.open.toggle(m.id)}
    >
      <span className="t">{fmtTime(m.at)}</span>
      <span className="icon">{m.role === "reasoning" ? "∴" : m.role === "user" ? "❯" : "↳"}</span>
      <span className="main text">
        <Markdown text={m.text} highlight={isOpen} />
      </span>
      <span className="r" />
    </div>
  );
}

function EventRow({ event: e }: { event: Event }) {
  return (
    <div className={`row event ${e.tone}`}>
      <span className="t">{fmtTime(e.at)}</span>
      <span className="icon">{e.tone === "error" ? "⚠" : "•"}</span>
      <span className="main">{e.text}</span>
      <span className="r" />
    </div>
  );
}
