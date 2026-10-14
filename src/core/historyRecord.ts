// What the history store keeps, and the backend's clients send: each thread's whole history once
// (`ThreadRecord`), and each commit's links to the threads that wrote it (`CommitRecord`, from
// `linkByContent`). Redacted before they leave the machine. Browser-safe.
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { Check } from "./checks.ts";
import { Entry, Labels, SessionOrigin, SessionSnapshot } from "./domain.ts";
import type { CommitHistory } from "./history.ts";
import { clipOutputs, LedgerThread } from "./ledger.ts";
import { redactEntries, redactLabels, redactor, redactText } from "./proof.ts";

export const HISTORY_FORMAT_VERSION = 1;

export const ThreadRecordV1 = Schema.Struct({
  formatVersion: Schema.Literal(1),
  thread: LedgerThread,
  /** When it was read from the session store (ISO). */
  takenAt: Schema.String,
  toolreaderVersion: Schema.String,
  /** Its whole history, every free-text field redacted, outputs clipped. */
  entries: Schema.Array(Entry),
  labels: Labels,
  redactions: Schema.Number,
  /** How the session started, as its files recorded it (redacted); absent from older clients. */
  snapshot: Schema.optional(SessionSnapshot),
  /**
   * Where it was read from (the file, home as `~`) and the SHA-256 of the bytes read: the source
   * version, apart from this record's own hash. Absent from older clients.
   */
  origin: Schema.optional(SessionOrigin),
});
export type ThreadRecord = typeof ThreadRecordV1.Type;

export const LinkVia = Schema.Literals(["asserted", "content", "trailer"]);

export const CommitRecordV1 = Schema.Struct({
  formatVersion: Schema.Literal(1),
  /** owner/name of the repo's origin. */
  repo: Schema.String,
  sha: Schema.String,
  /** Redacted. */
  subject: Schema.String,
  committedAt: Schema.String,
  /** Lines it adds that its parent didn't have, and how many its linked turns wrote. */
  novel: Schema.Number,
  explained: Schema.Number,
  links: Schema.Array(
    Schema.Struct({
      threadId: Schema.String,
      turns: Schema.Array(Schema.String),
      via: LinkVia,
      lines: Schema.Number,
      note: Schema.optional(Schema.String),
      declaredBy: Schema.optional(Schema.String),
      /** Tests and builds this thread ran for the commit; absent from older clients. */
      checks: Schema.optional(Schema.Array(Check)),
    }),
  ),
  linkedAt: Schema.String,
  toolreaderVersion: Schema.String,
});
export type CommitRecord = typeof CommitRecordV1.Type;

const FormatProbe = Schema.Struct({ formatVersion: Schema.Number });
const decodeFormat = Schema.decodeUnknownOption(FormatProbe);
const decodeThread = Schema.decodeUnknownResult(ThreadRecordV1);
const decodeCommit = Schema.decodeUnknownResult(CommitRecordV1);

/**
 * A stored payload as this toolreader reads it. A format newer than it knows (a newer toolreader
 * wrote it) is refused by name, so the message says to upgrade rather than dump the schema.
 */
const reader =
  <A>(what: string, decode: (u: unknown) => Result.Result<A, { readonly message: string }>) =>
  (payload: unknown): Result.Result<A, string> => {
    const format = Option.getOrNull(decodeFormat(payload))?.formatVersion ?? null;
    if (format !== null && format > HISTORY_FORMAT_VERSION)
      return Result.fail(
        `${what} format v${format} is newer than this toolreader reads (v${HISTORY_FORMAT_VERSION}): upgrade toolreader`,
      );
    return Result.mapError(decode(payload), (e) => `not a ${what} record: ${e.message}`);
  };
export const readThread = reader("thread", decodeThread);
export const readCommit = reader("commit", decodeCommit);

export const REJECT_REASONS = ["unsupported-format", "invalid", "not-redacted"] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];
export type Rejection = { readonly reason: RejectReason; readonly detail: string };

/**
 * A field path safe to send back: indexes and schema field names (camelCase letters) as they are;
 * anything else (a label id, which a session wrote) as `*`.
 */
const safePath = (path: ReadonlyArray<PropertyKey>) =>
  path
    .map((p) =>
      typeof p === "number" || (typeof p === "string" && /^[a-z][A-Za-z]*$/.test(p)) ? p : "*",
    )
    .join(".") || "(record)";

/** The first leaf or object key in `value` that `bad` flags, as a safe path; null when none. */
function firstField(
  value: unknown,
  bad: (leaf: unknown) => boolean,
  path: ReadonlyArray<string | number> = [],
): string | null {
  if (value === null || typeof value !== "object") return bad(value) ? safePath(path) : null;
  for (const [key, v] of Object.entries(value)) {
    const at = [...path, Array.isArray(value) ? Number(key) : key];
    if (!Array.isArray(value) && bad(key)) return safePath(at);
    const found = firstField(v, bad, at);
    if (found !== null) return found;
  }
  return null;
}

const redacts = (leaf: unknown) => typeof leaf === "string" && redactText(leaf).text !== leaf;
/** JSON's `1e400` parses as Infinity, which Schema.Number takes and jsonb can't hold. */
const nonFinite = (leaf: unknown) => typeof leaf === "number" && !Number.isFinite(leaf);
/** Ids are keys of Postgres text columns, which can't hold NUL. */
const goodId = (s: string) => s.length > 0 && s.length <= 1024 && !s.includes("\u0000");

/**
 * Whether a record someone sent may be stored, as the backend checks each one: a format it knows,
 * a valid record of it, and no text the redactor would still change. `detail` names fields and
 * versions only, never the record's text.
 */
const admit =
  <A>(
    what: string,
    standard: ReturnType<typeof Schema.toStandardSchemaV1<Schema.Codec<A, unknown>>>,
    ids: (a: A) => ReadonlyArray<string>,
  ) =>
  (record: unknown): Result.Result<A, Rejection> => {
    const format = Option.getOrNull(decodeFormat(record))?.formatVersion ?? null;
    if (format === null)
      return Result.fail({ reason: "invalid", detail: "formatVersion is missing or not a number" });
    if (format !== HISTORY_FORMAT_VERSION)
      return Result.fail({
        reason: "unsupported-format",
        detail: `${what} format v${format}; this backend takes v${HISTORY_FORMAT_VERSION}`,
      });
    const decoded = standard["~standard"].validate(record);
    if (decoded instanceof Promise || decoded.issues !== undefined) {
      const at = decoded instanceof Promise ? [] : (decoded.issues[0]?.path ?? []);
      const path = safePath(at.map((p) => (typeof p === "object" ? p.key : p)));
      return Result.fail({ reason: "invalid", detail: `not a ${what} record at ${path}` });
    }
    const value = decoded.value;
    const infinite = firstField(value, nonFinite);
    if (infinite !== null)
      return Result.fail({ reason: "invalid", detail: `not a finite number at ${infinite}` });
    if (!ids(value).every(goodId))
      return Result.fail({ reason: "invalid", detail: "an id is empty, too long or holds NUL" });
    const field = firstField(value, redacts);
    if (field !== null)
      return Result.fail({ reason: "not-redacted", detail: `the redactor would change ${field}` });
    return Result.succeed(value);
  };

const SHA = /^[0-9a-f]{4,64}$/;
/** `owner/name`, as long as the API's `:repo` takes it: a longer one would be stored, never read. */
export const REPO_MAX = 512;
export const admitThread = admit("thread", Schema.toStandardSchemaV1(ThreadRecordV1), (t) => [
  t.thread.id,
]);
export const admitCommit = admit("commit", Schema.toStandardSchemaV1(CommitRecordV1), (c) => [
  c.repo.length <= REPO_MAX ? c.repo : "",
  SHA.test(c.sha) ? c.sha : "",
  ...c.links.map((l) => l.threadId),
]);

/**
 * A thread's record: its whole history with every free-text field redacted (the home directory as
 * `~`), each output clipped to `maxOutput` bytes, head and tail.
 */
export function buildThreadRecord(input: {
  readonly thread: LedgerThread;
  readonly entries: ReadonlyArray<Entry>;
  readonly labels: Labels;
  readonly takenAt: string;
  readonly toolreaderVersion: string;
  readonly maxOutput: number;
  readonly home?: string | undefined;
  readonly snapshot?: SessionSnapshot | undefined;
  readonly origin?: SessionOrigin | undefined;
}): ThreadRecord {
  const { clean, count } = redactor(input.home);
  const redacted = redactEntries(input.entries, { outputs: true, home: input.home });
  const entries = clipOutputs(redacted.entries, input.maxOutput).map((e) =>
    e.type !== "action"
      ? e
      : {
          ...e,
          // A cut can land inside a placeholder (`TOKEN=[reda…`), which reads as a value again.
          ...(e.clipped && e.output ? { output: redactText(e.output).text } : {}),
          // Matching keys stay on this machine: the backend gets what the diff shows.
          ...(e.files ? { files: e.files.map(({ addedKeys: _, ...f }) => f) } : {}),
        },
  );
  return {
    formatVersion: HISTORY_FORMAT_VERSION,
    thread: { ...input.thread, title: clean(input.thread.title) },
    takenAt: input.takenAt,
    toolreaderVersion: input.toolreaderVersion,
    entries,
    labels: redactLabels(input.labels, clean),
    ...(input.snapshot
      ? {
          snapshot: Object.fromEntries(
            Object.entries(input.snapshot).map(([k, v]) => [k, clean(v ?? "")]),
          ) as SessionSnapshot,
        }
      : {}),
    ...(input.origin
      ? {
          origin: {
            ...input.origin,
            ...(input.origin.file ? { file: clean(input.origin.file) } : {}),
          },
        }
      : {}),
    redactions: redacted.redactions + count(),
  };
}

/** A commit's record: its links as `linkByContent` found them, its subject redacted. */
export function buildCommitRecord(input: {
  readonly repo: string;
  readonly subject: string;
  readonly committedAt: string;
  readonly history: CommitHistory;
  readonly linkedAt: string;
  readonly toolreaderVersion: string;
  readonly home?: string | undefined;
}): CommitRecord {
  const { clean } = redactor(input.home);
  return {
    formatVersion: HISTORY_FORMAT_VERSION,
    repo: input.repo,
    sha: input.history.sha,
    subject: clean(input.subject),
    committedAt: input.committedAt,
    novel: input.history.novel,
    explained: input.history.explained,
    links: input.history.links.map((l) => ({
      ...l,
      ...(l.note ? { note: clean(l.note) } : {}),
      ...(l.checks ? { checks: l.checks.map((c) => ({ ...c, title: clean(c.title) })) } : {}),
    })),
    linkedAt: input.linkedAt,
    toolreaderVersion: input.toolreaderVersion,
  };
}
