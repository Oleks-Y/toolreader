// Investigation coverage (plan D4): the files a linked session was seen reading for a commit, from
// its first linked turn (or its start) up to the commit. "Seen": a read action named the file.
// A file not listed wasn't seen read, which is not the same as unread (a shell `cat`, an editor,
// a person); there is no score for what's missing. Pure.
import * as Schema from "effect/Schema";

import type { Entry } from "./domain.ts";
import { turnId } from "./history.ts";
import { splitTurns } from "./tree.ts";

/** Paths kept per link; the rest are counted. */
export const MAX_READS = 200;

export const Reads = Schema.Struct({
  paths: Schema.Array(Schema.String),
  /** Read but not listed, past `MAX_READS`. */
  more: Schema.Number,
});
export type Reads = typeof Reads.Type;

const CLOCK_SKEW_MS = 2_000;

export function readsFor(input: {
  readonly entries: ReadonlyArray<Entry>;
  readonly turns: ReadonlyArray<string>;
  readonly committedAt: string;
}): Reads {
  const until = Date.parse(input.committedAt) + CLOCK_SKEW_MS;
  const linked = new Set(input.turns);
  const turns = splitTurns(input.entries);
  const first =
    linked.size === 0 ? 0 : turns.findIndex((t) => linked.has(turnId(t.prompt, t.entries)));
  const seen = new Set<string>();
  for (const t of first < 0 ? [] : turns.slice(first))
    for (const e of t.entries)
      if (e.type === "action" && e.kind === "read" && Date.parse(e.at) <= until)
        for (const p of e.targets ?? []) seen.add(p);
  const paths = [...seen].sort();
  return { paths: paths.slice(0, MAX_READS), more: Math.max(0, paths.length - MAX_READS) };
}
