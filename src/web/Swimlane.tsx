import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ACTION_KINDS, type Action, type ActionKind } from "../core/domain.ts";
import { fmtDuration, fmtTime } from "./util.ts";

const MAX_GAP_MS = 60_000; // idle gaps longer than this are drawn as 60s
const LANE_H = 16;
const PAD_L = 56;
const PAD_T = 14;

export type Range = { from: string; to: string };

type Props = {
  actions: Action[];
  turnStarts: string[];
  hiddenKinds: Set<ActionKind>;
  range: Range | null;
  onRange: (range: Range | null) => void;
  onPick: (id: string) => void;
};

/** Time → x on a compressed axis where long idle gaps collapse. */
function useAxis(actions: Action[]) {
  return useMemo(() => {
    const pos: number[] = [];
    const gaps: Array<{ at: number; ms: number }> = [];
    let c = 0;
    actions.forEach((a, i) => {
      if (i > 0) {
        const d = Date.parse(a.at) - Date.parse(actions[i - 1]!.at);
        if (d > MAX_GAP_MS) gaps.push({ at: c + MAX_GAP_MS / 2, ms: d });
        c += Math.max(0, Math.min(d, MAX_GAP_MS));
      }
      pos.push(c);
    });
    return { pos, gaps, total: Math.max(c, 1) };
  }, [actions]);
}

export function Swimlane({ actions, turnStarts, hiddenKinds, range, onRange, onPick }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);
  const { pos, gaps, total } = useAxis(actions);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const lanes = ACTION_KINDS;
  const height = PAD_T + lanes.length * LANE_H + 22;
  const x = (c: number) => PAD_L + (c / total) * (width - PAD_L - 10);
  const firstIndexAtOrAfter = (iso: string) => {
    const i = actions.findIndex((a) => a.at >= iso);
    return i < 0 ? actions.length - 1 : i;
  };

  const toLocalX = (e: React.PointerEvent) =>
    e.clientX - (wrap.current?.getBoundingClientRect().left ?? 0);
  const finishDrag = () => {
    if (!drag) return;
    const [a, b] = [Math.min(drag.x0, drag.x1), Math.max(drag.x0, drag.x1)];
    setDrag(null);
    if (b - a < 4) return;
    const inside = actions.filter((_, i) => x(pos[i]!) >= a && x(pos[i]!) <= b);
    if (inside.length) onRange({ from: inside[0]!.at, to: inside.at(-1)!.at });
  };

  const rangeX =
    range && actions.length
      ? [
          x(pos[firstIndexAtOrAfter(range.from)]!),
          x(
            pos[
              Math.max(
                0,
                actions.findLastIndex((a) => a.at <= range.to),
              )
            ]!,
          ),
        ]
      : null;

  return (
    <div className="swimlane" ref={wrap}>
      <svg
        width={width}
        height={height}
        onPointerDown={(e) => {
          if ((e.target as Element).tagName === "circle") return;
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
          setDrag({ x0: toLocalX(e), x1: toLocalX(e) });
        }}
        onPointerMove={(e) => drag && setDrag({ ...drag, x1: toLocalX(e) })}
        onPointerUp={finishDrag}
        onDoubleClick={() => onRange(null)}
      >
        {lanes.map((k, i) => (
          <g key={k} className={hiddenKinds.has(k) ? "lane off" : "lane"}>
            <text x={4} y={PAD_T + i * LANE_H + 11} className={`lane-label k-${k}`}>
              {k}
            </text>
            <line
              x1={PAD_L}
              x2={width - 10}
              y1={PAD_T + i * LANE_H + 7}
              y2={PAD_T + i * LANE_H + 7}
            />
          </g>
        ))}
        {gaps.map((g) => (
          <g key={g.at} className="gap">
            <line x1={x(g.at)} x2={x(g.at)} y1={PAD_T - 4} y2={height - 20} />
            <text x={x(g.at) + 3} y={PAD_T - 4}>
              {fmtDuration(g.ms).split(" ")[0]}
            </text>
          </g>
        ))}
        {turnStarts.map((t, i) => {
          const idx = firstIndexAtOrAfter(t);
          if (idx < 0 || !actions.length) return null;
          const tx = x(pos[idx]!);
          return (
            <g key={t} className="turn-mark">
              <line x1={tx} x2={tx} y1={PAD_T - 4} y2={height - 18} />
              <text x={tx + 3} y={height - 6}>
                {`T${i + 1} ${fmtTime(t).slice(0, 5)}`}
              </text>
            </g>
          );
        })}
        {rangeX && (
          <rect
            className="range"
            x={rangeX[0]! - 3}
            width={Math.max(6, rangeX[1]! - rangeX[0]! + 6)}
            y={PAD_T - 4}
            height={lanes.length * LANE_H + 6}
          />
        )}
        {drag && (
          <rect
            className="brush"
            x={Math.min(drag.x0, drag.x1)}
            width={Math.abs(drag.x1 - drag.x0)}
            y={PAD_T - 4}
            height={lanes.length * LANE_H + 6}
          />
        )}
        {actions.map((a, i) => {
          const lane = lanes.indexOf(a.kind);
          return (
            <circle
              key={a.id}
              cx={x(pos[i]!)}
              cy={PAD_T + lane * LANE_H + 7}
              r={a.status === "failed" ? 4.5 : 3}
              className={`dot k-${a.kind} ${a.status}${hiddenKinds.has(a.kind) ? " off" : ""}`}
              onClick={() => onPick(a.id)}
            >
              <title>{`${fmtTime(a.at)}  ${a.status === "failed" ? "✗ " : ""}${a.title}`}</title>
            </circle>
          );
        })}
      </svg>
    </div>
  );
}
