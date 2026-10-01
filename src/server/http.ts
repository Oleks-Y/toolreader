import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { ToolreaderApi } from "../core/api.ts";
import { Labeler } from "./Labeler.ts";
import { ServerConfig } from "./ServerConfig.ts";
import { ThreadStore } from "./ThreadStore.ts";

/** At most this many items go to one Codex call. */
const MAX_LABEL_ITEMS = 150;

const ThreadsHandlers = HttpApiBuilder.group(
  ToolreaderApi,
  "threads",
  Effect.fn(function* (handlers) {
    const store = yield* ThreadStore;
    const labeler = yield* Labeler;
    return handlers
      .handle("list", () => store.list)
      .handle("get", ({ params }) =>
        labeler.forThread(params.id).pipe(Effect.flatMap((labels) => store.get(params.id, labels))),
      )
      .handle("head", ({ params }) => store.head(params.id));
  }),
);

const LabelsHandlers = HttpApiBuilder.group(
  ToolreaderApi,
  "labels",
  Effect.fn(function* (handlers) {
    const labeler = yield* Labeler;
    return handlers.handle("create", ({ payload }) =>
      labeler.label(payload.threadId, payload.context, payload.items.slice(0, MAX_LABEL_ITEMS)),
    );
  }),
);

/** Serves the built web app from dist/, falling back to index.html. */
const StaticRoute = HttpRouter.add(
  "GET",
  "*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const { distDir } = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const pathname = new URL(request.url, "http://localhost").pathname;
    const root = path.resolve(distDir);
    const file = path.resolve(root, `.${decodeURIComponent(pathname)}`);
    if (file !== root && !file.startsWith(`${root}${path.sep}`))
      return HttpServerResponse.text("Invalid path", { status: 400 });
    const isFile = yield* fs.stat(file).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.orElseSucceed(() => false),
    );
    if (isFile) return yield* HttpServerResponse.file(file);
    const index = path.join(root, "index.html");
    if (yield* fs.exists(index).pipe(Effect.orElseSucceed(() => false)))
      return yield* HttpServerResponse.file(index);
    return HttpServerResponse.text(
      "Not built. Run `pnpm start`, or `pnpm dev` and open the Vite URL.",
      { status: 503 },
    );
  }).pipe(Effect.orDie),
);

const ApiRoutes = HttpApiBuilder.layer(ToolreaderApi).pipe(
  Layer.provide([ThreadsHandlers, LabelsHandlers]),
);

export const HttpServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const { port } = yield* ServerConfig;
    const NodeHttp = yield* Effect.promise(() => import("node:http"));
    // Local only: this exposes every agent session on the machine.
    return HttpRouter.serve(Layer.mergeAll(ApiRoutes, StaticRoute)).pipe(
      Layer.provide(NodeHttpServer.layer(NodeHttp.createServer, { port, host: "127.0.0.1" })),
    );
  }),
);
