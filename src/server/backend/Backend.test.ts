// The backend over real HTTP (a test server on 127.0.0.1) and a real Postgres (testPostgres.ts),
// called through the typed client a CLI would use.
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import { BackendApi, CLIENT_HEADER, LIMITS } from "../../core/backendApi.ts";
import { checkpointKey, type Checkpoint } from "../../core/checkpoint.ts";
import v1Json from "../../core/fixtures/checkpoint-v1.json" with { type: "json" };
import { BackendRoutes, MIN_CLIENT } from "./Backend.ts";
import { CheckpointStore } from "./CheckpointStore.ts";
import { PgMigrationsLive } from "./PgMigrations.ts";
import { PgTestLive } from "./testPostgres.ts";
import { privateTracer } from "../Trace.ts";

const v1 = v1Json as unknown as Checkpoint;
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Spans the server opened, to check that a client's trace continues into it. */
const spans: Tracer.NativeSpan[] = [];
const recorder = Tracer.make({
  span(options) {
    const span = new Tracer.NativeSpan(options);
    spans.push(span);
    return span;
  },
});

const TestLive = HttpRouter.serve(BackendRoutes, {
  disableListenLog: true,
  disableLogger: true,
  routerConfig: { maxParamLength: 2048 },
}).pipe(
  // Through the CLI's own filter, so the attributes checked are the ones a collector would get.
  Layer.provide(Layer.succeed(Tracer.Tracer, privateTracer(recorder, "all"))),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(CheckpointStore.layer),
  Layer.provideMerge(PgMigrationsLive),
  Layer.provideMerge(PgTestLive),
  Layer.provide(NodeServices.layer),
);

const headers = (token: string | null, client: string | null = MIN_CLIENT) => ({
  ...(token === null ? {} : { authorization: `Bearer ${token}` }),
  ...(client === null ? {} : { [CLIENT_HEADER]: client }),
});

const clientWith = (h: Record<string, string>) =>
  HttpApiClient.make(BackendApi, {
    transformClient: HttpClient.mapRequest(HttpClientRequest.setHeaders(h)),
  });

const token = (workspace: string) =>
  Effect.flatMap(CheckpointStore, (s) => s.createToken(workspace, "test"));

/** The fixture as another thread's checkpoint, keyed as the backend recomputes it. */
const forThread = (threadId: string, text = "fix it"): Checkpoint => {
  const entries = v1.entries.map((e, i) => (i === 0 && e.type === "message" ? { ...e, text } : e));
  const thread = { ...v1.thread, id: threadId };
  return {
    ...v1,
    thread,
    entries,
    id: checkpointKey({
      trigger: v1.trigger,
      threadId,
      repo: v1.repo.name,
      commit: v1.commit && { sha: v1.commit.sha, role: v1.commit.role },
      entries,
    }),
  };
};

const PutResponse = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({ result: Schema.String, reason: Schema.optional(Schema.String) }),
  ),
});
const decodePutResponse = Schema.decodeUnknownEffect(PutResponse);

const status = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.flatMap(HttpClient.HttpClient, (c) => c.execute(request)).pipe(
    Effect.map((r) => r.status),
  );

describe("Backend", () => {
  it.layer(TestLive, { timeout: 120_000 })((it) => {
    it.effect("answers health without a token, meta with one", () =>
      Effect.gen(function* () {
        const anonymous = yield* clientWith(headers(null, null));
        assert.deepStrictEqual(yield* anonymous.system.health(), { ok: true });
        assert.strictEqual((yield* Effect.flip(anonymous.system.meta()))._tag, "Unauthorized");
        const api = yield* clientWith(headers(yield* token("meta")));
        const meta = yield* api.system.meta();
        assert.deepStrictEqual(
          [meta.apiVersion, meta.minClient, meta.formats.checkpoint],
          [1, MIN_CLIENT, [1]],
        );
      }),
    );

    it.effect(
      "refuses a missing or unknown token (401), another workspace (403), an old client (426)",
      () =>
        Effect.gen(function* () {
          const good = yield* token("auth");
          const tag = (h: Record<string, string>, ws = "auth") =>
            Effect.flatMap(clientWith(h), (api) =>
              Effect.flip(api.checkpoints.forThread({ params: { ws, threadId: "t" }, query: {} })),
            ).pipe(Effect.map((e) => e._tag));
          assert.strictEqual(yield* tag(headers(null)), "Unauthorized");
          assert.strictEqual(yield* tag(headers(`${good}x`)), "Unauthorized");
          assert.strictEqual(yield* tag(headers(good), "someone-else"), "Forbidden");
          for (const client of [null, "0.0.9", "latest"]) {
            const error = yield* Effect.flip(
              Effect.flatMap(clientWith(headers(good, client)), (api) =>
                api.checkpoints.forThread({ params: { ws: "auth", threadId: "t" }, query: {} }),
              ),
            );
            assert.strictEqual(error._tag, "UpgradeRequired");
            assert.strictEqual(error._tag === "UpgradeRequired" && error.minClient, MIN_CLIENT);
          }
          // The version is checked first: an old client hears "upgrade" even with a bad token.
          assert.strictEqual(yield* tag(headers(null, "0.0.1")), "UpgradeRequired");
          const api = yield* clientWith(headers(good, "0.2.0-alpha.1"));
          assert.deepStrictEqual(
            yield* api.checkpoints.forThread({ params: { ws: "auth", threadId: "t" }, query: {} }),
            [],
          );
        }),
    );

    it.effect("stores a record once: inserted, exists, differs, replaced", () =>
      Effect.gen(function* () {
        const api = yield* clientWith(headers(yield* token("put")));
        const put = (items: ReadonlyArray<unknown>, replace?: "true") =>
          api.checkpoints
            .put({ params: { ws: "put" }, query: replace ? { replace } : {}, payload: { items } })
            .pipe(Effect.map((r) => r.results.map((x) => x.result)));
        const cp = forThread("idem");
        assert.deepStrictEqual(yield* put([cp]), ["inserted"]);
        assert.deepStrictEqual(yield* put([cp, { ...cp, takenAt: "2030-01-01T00:00:00Z" }]), [
          "exists",
          "exists",
        ]);
        const changed = forThread("idem", "fix it properly");
        assert.strictEqual(changed.id, cp.id);
        assert.deepStrictEqual(yield* put([changed]), ["differs"]);
        assert.deepStrictEqual(yield* put([changed], "true"), ["replaced"]);
        const back = yield* api.checkpoints.get({ params: { ws: "put", id: cp.id } });
        assert.deepStrictEqual(back.entries[0], changed.entries[0]);
      }),
    );

    it.effect("rejects bad records one by one and stores the rest", () =>
      Effect.gen(function* () {
        const api = yield* clientWith(headers(yield* token("reject")));
        const secret = "ghp_0123456789abcdefghijABCDEFGHIJ012345";
        const good = forThread("kept");
        const { results } = yield* api.checkpoints.put({
          params: { ws: "reject" },
          query: {},
          payload: {
            items: [
              { ...forThread("future"), formatVersion: 2 },
              { ...forThread("broken"), turns: "nope" },
              { ...forThread("renamed"), id: "manual:someone-else" },
              forThread("leaky", `use ${secret}`),
              forThread("huge", "x".repeat(LIMITS.recordBytes)),
              good,
            ],
          },
        });
        assert.deepStrictEqual(
          results.map((r) => [r.result, r.result === "rejected" ? r.reason : null]),
          [
            ["rejected", "unsupported-format"],
            ["rejected", "invalid"],
            ["rejected", "key-mismatch"],
            ["rejected", "not-redacted"],
            ["rejected", "too-large"],
            ["inserted", null],
          ],
        );
        assert.notInclude(json(results), secret);
        assert.strictEqual(results[3]?.id, forThread("leaky").id);
        const stored = (threadId: string) =>
          api.checkpoints.forThread({ params: { ws: "reject", threadId }, query: {} });
        assert.deepStrictEqual(
          (yield* stored("kept")).map((c) => c.id),
          [good.id],
        );
        assert.deepStrictEqual(yield* stored("leaky"), []);
      }),
    );

    it.effect(
      "rejects records Postgres would refuse on their own lines, and the batch goes on",
      () =>
        Effect.gen(function* () {
          const t = yield* token("pg-refuses");
          const good = forThread("after");
          const nul = "t\u0000x";
          const body = json({
            items: [
              { ...forThread("timeless"), takenAt: "now" },
              { ...forThread("nul"), thread: { ...v1.thread, id: nul }, id: forThread(nul).id },
              good,
            ],
          });
          const response = yield* Effect.flatMap(HttpClient.HttpClient, (c) =>
            c.execute(
              HttpClientRequest.post("/v1/workspaces/pg-refuses/checkpoints").pipe(
                HttpClientRequest.setHeaders(headers(t)),
                HttpClientRequest.bodyText(body, "application/json"),
              ),
            ),
          );
          assert.strictEqual(response.status, 200);
          const { results } = yield* Effect.flatMap(response.json, decodePutResponse);
          assert.deepStrictEqual(
            results.map((r) => [r.result, r.reason]),
            [
              ["rejected", "invalid"],
              ["rejected", "invalid"],
              ["inserted", undefined],
            ],
          );
          // `1e400` parses as Infinity: the payload codec refuses the request before any record.
          const infinite = json({ items: [good] }).replace(
            /"redactions":\d+/,
            '"redactions":1e400',
          );
          assert.strictEqual(
            yield* status(
              HttpClientRequest.post("/v1/workspaces/pg-refuses/checkpoints").pipe(
                HttpClientRequest.setHeaders(headers(t)),
                HttpClientRequest.bodyText(infinite, "application/json"),
              ),
            ),
            400,
          );
        }),
    );

    it.effect("answers an unreadable stored record with 503, quoting none of it", () =>
      Effect.gen(function* () {
        const t = yield* token("unreadable");
        const sql = yield* SqlClient.SqlClient;
        const broken = { ...forThread("broken"), turns: "secret words" };
        yield* sql`
          INSERT INTO checkpoints (workspace_id, id, payload, taken_at, content_sha, client)
          SELECT id, ${broken.id}, ${json(broken)}::jsonb, now(), 'x', 'test'
          FROM workspaces WHERE slug = 'unreadable'`;
        const response = yield* Effect.flatMap(HttpClient.HttpClient, (c) =>
          c.execute(
            HttpClientRequest.get(
              `/v1/workspaces/unreadable/checkpoints/${encodeURIComponent(broken.id)}`,
            ).pipe(HttpClientRequest.setHeaders(headers(t))),
          ),
        );
        assert.strictEqual(response.status, 503);
        assert.notInclude(yield* response.text, "secret words");
      }),
    );

    it.effect(
      "refuses a body over 8 MB (413) or without a length (411), a batch over 100 records or a bad SHA (400)",
      () =>
        Effect.gen(function* () {
          const t = yield* token("limits");
          const post = (body: string) =>
            status(
              HttpClientRequest.post("/v1/workspaces/limits/checkpoints").pipe(
                HttpClientRequest.setHeaders(headers(t)),
                HttpClientRequest.bodyText(body, "application/json"),
              ),
            );
          assert.strictEqual(yield* post(json({ items: ["x".repeat(LIMITS.requestBytes)] })), 413);
          assert.strictEqual(
            yield* post(json({ items: Array.from({ length: 101 }, () => ({})) })),
            400,
          );
          assert.strictEqual(yield* post(json({ items: [] })), 400);
          const rewrite = (body: string) =>
            status(
              HttpClientRequest.post("/v1/workspaces/limits/repos/o%2Fr/rewrites").pipe(
                HttpClientRequest.setHeaders(headers(t)),
                HttpClientRequest.bodyText(body, "application/json"),
              ),
            );
          const pair = (oldSha: string) => json({ pairs: [{ oldSha, newSha: "abc123" }] });
          assert.strictEqual(yield* rewrite(pair("a".repeat(LIMITS.requestBytes))), 413);
          assert.strictEqual(yield* rewrite(pair("not a sha")), 400);
          assert.strictEqual(yield* rewrite(pair("abc124")), 200);
          // A streamed body can't be measured before it is read.
          const chunked = yield* status(
            HttpClientRequest.post("/v1/workspaces/limits/checkpoints").pipe(
              HttpClientRequest.setHeaders(headers(t)),
              HttpClientRequest.bodyStream(Stream.make(new TextEncoder().encode('{"items":[1]}')), {
                contentType: "application/json",
              }),
            ),
          );
          assert.strictEqual(chunked, 411);
        }),
    );

    it.effect("finds a commit's history by SHA, through rewrites, by patch-id; 404 for none", () =>
      Effect.gen(function* () {
        const api = yield* clientWith(headers(yield* token("commits")));
        const ws = "commits";
        yield* api.checkpoints.put({ params: { ws }, query: {}, payload: { items: [v1] } });
        const found = (sha: string, patchId?: string) =>
          api.checkpoints
            .forCommit({
              params: { ws, repo: v1.repo.name, sha },
              query: patchId === undefined ? {} : { patchId },
            })
            .pipe(Effect.map((r) => r.map((x) => [x.checkpoint.id, x.matched])));
        assert.deepStrictEqual(yield* found("abc123"), [[v1.id, "sha"]]);
        assert.deepStrictEqual(yield* found("be0001", "p1"), [[v1.id, "patch-id"]]);
        assert.deepStrictEqual(yield* found("ae0001", "p9"), []);
        const added = yield* api.checkpoints.rewrite({
          params: { ws, repo: v1.repo.name },
          payload: { pairs: [{ oldSha: "abc123", newSha: "ae0001" }] },
        });
        assert.deepStrictEqual(added, { added: 1 });
        assert.deepStrictEqual(yield* found("ae0001", "p9"), [[v1.id, "rewrite"]]);
        // The id holds ':' and '/': the client encodes it, the router decodes it.
        const back = yield* api.checkpoints.get({ params: { ws, id: v1.id } });
        assert.strictEqual(back.id, v1.id);
        const missing = yield* Effect.flip(api.checkpoints.get({ params: { ws, id: "nope" } }));
        assert.strictEqual(missing._tag, "NotFound");
      }),
    );

    it.effect("pages a thread's records oldest first", () =>
      Effect.gen(function* () {
        const api = yield* clientWith(headers(yield* token("pages")));
        const turns = [3, 1, 2].map((n) => ({
          ...forThread("paged"),
          trigger: "manual" as const,
          commit: null,
          takenAt: `2026-01-0${n}T00:00:00.000Z`,
          entries: v1.entries.slice(0, n),
        }));
        const keyed = turns.map((c) => ({
          ...c,
          id: checkpointKey({ ...c, threadId: c.thread.id, repo: c.repo.name, commit: null }),
        }));
        yield* api.checkpoints.put({
          params: { ws: "pages" },
          query: {},
          payload: { items: keyed },
        });
        const page = (query: { limit?: number; after?: string }) =>
          api.checkpoints
            .forThread({ params: { ws: "pages", threadId: "paged" }, query })
            .pipe(Effect.map((cs) => cs.map((c) => c.takenAt.slice(0, 10))));
        const first = yield* page({ limit: 2 });
        assert.deepStrictEqual(first, ["2026-01-01", "2026-01-02"]);
        const ids = (yield* api.checkpoints.forThread({
          params: { ws: "pages", threadId: "paged" },
          query: { limit: 2 },
        })).map((c) => c.id);
        assert.deepStrictEqual(yield* page({ limit: 2, after: ids[1]! }), ["2026-01-03"]);
        assert.deepStrictEqual(yield* page({ after: "nope" }), []);
        const tooMany = yield* Effect.flip(page({ limit: LIMITS.page + 1 }));
        assert.notStrictEqual(tooMany._tag, "BackendFailed");
      }),
    );

    it.effect("keeps workspaces apart", () =>
      Effect.gen(function* () {
        const a = yield* clientWith(headers(yield* token("team-a")));
        const b = yield* clientWith(headers(yield* token("team-b")));
        const cp = forThread("private");
        yield* a.checkpoints.put({ params: { ws: "team-a" }, query: {}, payload: { items: [cp] } });
        const denied = yield* Effect.flip(
          b.checkpoints.get({ params: { ws: "team-a", id: cp.id } }),
        );
        assert.strictEqual(denied._tag, "Forbidden");
        const theirs = yield* Effect.flip(
          b.checkpoints.get({ params: { ws: "team-b", id: cp.id } }),
        );
        assert.strictEqual(theirs._tag, "NotFound");
        assert.deepStrictEqual(
          yield* b.checkpoints.forThread({
            params: { ws: "team-b", threadId: "private" },
            query: {},
          }),
          [],
        );
      }),
    );

    it.effect("continues the caller's W3C trace", () =>
      Effect.gen(function* () {
        const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
        const parent = "00f067aa0ba902b7";
        const code = yield* status(
          HttpClientRequest.get("/v1/health").pipe(
            HttpClientRequest.setHeader("traceparent", `00-${traceId}-${parent}-01`),
          ),
        ).pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false));
        assert.strictEqual(code, 200);
        const server = spans.find((s) => s.traceId === traceId && s.kind === "server");
        assert.isDefined(server);
        assert.strictEqual(server?.parent._tag === "Some" && server.parent.value.spanId, parent);
        // A caller that asks not to be sampled still gets its request recorded.
        const unsampled = "5bf92f3577b34da6a3ce929d0e0e4736";
        yield* status(
          HttpClientRequest.get("/v1/health").pipe(
            HttpClientRequest.setHeader("traceparent", `00-${unsampled}-${parent}-00`),
          ),
        ).pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false));
        const kept = spans.find((s) => s.traceId === unsampled && s.kind === "server");
        assert.strictEqual(kept?.sampled, true);
      }),
    );

    it.effect("refuses NUL, a bad SHA or an overlong repo in paths and queries (400)", () =>
      Effect.gen(function* () {
        const t = yield* token("params");
        const get = (path: string) =>
          status(HttpClientRequest.get(path).pipe(HttpClientRequest.setHeaders(headers(t))));
        assert.strictEqual(
          yield* get("/v1/workspaces/params/threads/t/checkpoints?after=%00"),
          400,
        );
        assert.strictEqual(yield* get("/v1/workspaces/params/checkpoints/a%00b"), 400);
        assert.strictEqual(
          yield* get("/v1/workspaces/params/repos/o%2Fr/commits/ABC123/checkpoints"),
          400,
        );
        assert.strictEqual(
          yield* get("/v1/workspaces/params/repos/o%2Fr/commits/abc123/checkpoints"),
          200,
        );
        const rewrite = yield* status(
          HttpClientRequest.post(`/v1/workspaces/params/repos/${"é".repeat(600)}/rewrites`).pipe(
            HttpClientRequest.setHeaders(headers(t)),
            HttpClientRequest.bodyText(json({ pairs: [] }), "application/json"),
          ),
        );
        assert.strictEqual(rewrite, 400);
      }),
    );

    it.effect("spans each request with route, status and upload counts, and nothing private", () =>
      Effect.gen(function* () {
        const t = yield* token("spans");
        const api = yield* clientWith(headers(t));
        const secret = "ghp_0123456789abcdefghijABCDEFGHIJ012345";
        const traceId = yield* Effect.gen(function* () {
          yield* api.checkpoints.put({
            params: { ws: "spans" },
            query: {},
            payload: {
              items: [
                forThread("counted"),
                forThread("counted"),
                forThread("leaky", `use ${secret} in /Users/me/notes`),
                { ...forThread("future"), formatVersion: 2 },
              ],
            },
          });
          return (yield* Effect.currentSpan).traceId;
        }).pipe(Effect.withSpan("cli"));
        const mine = spans.filter((s) => s.traceId === traceId);
        const server = mine.find((s) => s.kind === "server");
        assert.strictEqual(server?.status._tag, "Ended");
        const attributes = Object.fromEntries(server!.attributes);
        assert.deepInclude(attributes, {
          "http.route": "/v1/workspaces/:ws/checkpoints",
          "http.request.method": "POST",
          "http.response.status_code": 200,
        });
        const upload = mine.find((s) => s.name === "Backend.put");
        assert.deepStrictEqual(Object.fromEntries(upload!.attributes), {
          items: 4,
          "result.inserted": 1,
          "result.exists": 1,
          "result.differs": 0,
          "result.replaced": 0,
          "result.rejected": 2,
          "rejected.unsupported-format": 1,
          "rejected.invalid": 0,
          "rejected.key-mismatch": 0,
          "rejected.not-redacted": 1,
          "rejected.too-large": 0,
        });
        // No URL, header, address, record text, path or credential on any span of the request.
        const all = mine.flatMap((s) => [...s.attributes]);
        assert.deepStrictEqual(
          all.filter(([k]) => /^(url\.|http\.(request|response)\.header\.|client\.)/.test(k)),
          [],
        );
        const values = json(all.map(([, v]) => v));
        for (const leak of [secret, "/Users/me", t, "counted", "leaky"])
          assert.notInclude(values, leak);
      }),
    );
  });
});
