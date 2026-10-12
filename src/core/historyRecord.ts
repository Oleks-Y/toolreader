// What the history store keeps, and the backend's clients send: each thread's whole history once
// (`ThreadRecord`), and each commit's links to the threads that wrote it (`CommitRecord`, from
// `linkByContent`). Redacted before they leave the machine. Browser-safe.
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { Entry, Labels } from "./domain.ts";
import { LedgerThread } from "./ledger.ts";

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
});
export type ThreadRecord = typeof ThreadRecordV1.Type;

export const LinkVia = Schema.Literals(["content", "trailer"]);

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
