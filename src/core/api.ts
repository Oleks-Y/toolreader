// HTTP contract shared by the server and the browser client. Keep it free of server code.
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

import { LabelItem, Labels, ThreadHead, ThreadSummary, ThreadView } from "./domain.ts";
import { LedgerRange } from "./ledger.ts";

export class ThreadNotFound extends Schema.TaggedErrorClass<ThreadNotFound>()("ThreadNotFound", {
  threadId: Schema.String,
}) {}

export class InvalidProofScope extends Schema.TaggedErrorClass<InvalidProofScope>()(
  "InvalidProofScope",
  { message: Schema.String },
) {}

export class ProofWriteFailed extends Schema.TaggedErrorClass<ProofWriteFailed>()(
  "ProofWriteFailed",
  { message: Schema.String },
) {}

export class LedgerFailed extends Schema.TaggedErrorClass<LedgerFailed>()("LedgerFailed", {
  message: Schema.String,
}) {}

export class LabelingFailed extends Schema.TaggedErrorClass<LabelingFailed>()("LabelingFailed", {
  message: Schema.String,
}) {}

export class ThreadsApi extends HttpApiGroup.make("threads")
  .add(
    HttpApiEndpoint.get("list", "/threads", { success: Schema.Array(ThreadSummary) }),
    HttpApiEndpoint.get("get", "/threads/:id", {
      params: { id: Schema.String },
      success: ThreadView,
      error: ThreadNotFound.pipe(HttpApiSchema.status(404)),
    }),
    HttpApiEndpoint.get("head", "/threads/:id/head", {
      params: { id: Schema.String },
      success: ThreadHead,
      error: ThreadNotFound.pipe(HttpApiSchema.status(404)),
    }),
    // Proof-of-work artifact as pretty JSON (a download). Scope: `turns=3-5` and/or `from`/`to` ISO times.
    HttpApiEndpoint.get("proof", "/threads/:id/proof", {
      params: { id: Schema.String },
      query: {
        turns: Schema.optional(Schema.String),
        from: Schema.optional(Schema.String),
        to: Schema.optional(Schema.String),
        outputs: Schema.optional(Schema.Literals(["include", "omit"])),
      },
      success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "application/json" })),
      error: [
        ThreadNotFound.pipe(HttpApiSchema.status(404)),
        InvalidProofScope.pipe(HttpApiSchema.status(400)),
      ],
    }),
  )
  .prefix("/api") {}

export class LabelsApi extends HttpApiGroup.make("labels")
  .add(
    HttpApiEndpoint.post("create", "/labels", {
      payload: Schema.Struct({
        threadId: Schema.String,
        context: Schema.String,
        items: Schema.Array(LabelItem),
      }),
      success: Labels,
      error: LabelingFailed.pipe(HttpApiSchema.status(502)),
    }),
  )
  .prefix("/api") {}

export class LedgerApi extends HttpApiGroup.make("ledger")
  .add(
    HttpApiEndpoint.get("repos", "/ledger/repos", {
      success: Schema.Array(Schema.Struct({ path: Schema.String, title: Schema.String })),
    }),
    HttpApiEndpoint.get("range", "/ledger/range", {
      query: { repo: Schema.String, range: Schema.optional(Schema.String) },
      success: LedgerRange,
      error: LedgerFailed.pipe(HttpApiSchema.status(400)),
    }),
  )
  .prefix("/api") {}

export class ToolreaderApi extends HttpApi.make("toolreader")
  .add(ThreadsApi)
  .add(LabelsApi)
  .add(LedgerApi) {}
