// HTTP contract shared by the server and the browser client. Keep it free of server code.
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

import { LabelItem, Labels, ThreadHead, ThreadSummary, ThreadView } from "./domain.ts";

export class ThreadNotFound extends Schema.TaggedErrorClass<ThreadNotFound>()("ThreadNotFound", {
  threadId: Schema.String,
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

export class ToolreaderApi extends HttpApi.make("toolreader").add(ThreadsApi).add(LabelsApi) {}
