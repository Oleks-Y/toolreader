// A review manifest (plan D3): a past review's whole decision context, frozen when the review was
// made so it reopens exactly as it was. The commits under review, the conclusions shown for them
// (each commit's links, checks and reads as recorded then), the version of every session they
// cite, the methods that derived them, the repo's findings and their statuses, and the decision.
// It holds no session bodies, so it never keeps evidence past its retention: when a session is
// removed, the conclusions drawn from it go from every manifest too, and reopening says so.
import * as Schema from "effect/Schema";

import { CommitRecordV1 } from "./historyRecord.ts";
import { FINDING_STATUSES } from "./insights.ts";

export const VERDICTS = ["approved", "changes requested", "noted"] as const;

export const ReviewManifest = Schema.Struct({
  manifestVersion: Schema.Literal(1),
  id: Schema.String,
  repo: Schema.String,
  /** The range as the reviewer named it, and its commits, oldest first. */
  range: Schema.String,
  shas: Schema.Array(Schema.String),
  createdAt: Schema.String,
  /** The token or GitHub login that froze it. */
  by: Schema.String,
  commits: Schema.Array(CommitRecordV1),
  /** Every cited session at the version the review saw. */
  evidence: Schema.Array(Schema.Struct({ threadId: Schema.String, version: Schema.String })),
  methods: Schema.Struct({
    checks: Schema.String,
    detectors: Schema.String,
    server: Schema.String,
  }),
  findings: Schema.Array(
    Schema.Struct({ id: Schema.String, status: Schema.Literals(FINDING_STATUSES) }),
  ),
  decision: Schema.Struct({ verdict: Schema.Literals(VERDICTS), note: Schema.String }),
  /** Sessions removed since: their conclusions were taken out of `commits`. */
  removed: Schema.optional(Schema.Array(Schema.String)),
});
export type ReviewManifest = typeof ReviewManifest.Type;

/** A cited session now: still at the version reviewed, replaced since, removed, or never stored. */
export const EVIDENCE_NOW = ["same", "replaced", "deleted", "expired", "missing"] as const;
export type EvidenceNow = (typeof EVIDENCE_NOW)[number];
