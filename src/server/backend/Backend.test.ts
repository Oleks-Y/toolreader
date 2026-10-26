// The backend over real HTTP (a test server on 127.0.0.1) and a real Postgres (testPostgres.ts),
// called through the typed client a CLI would use.
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import type { Entry } from "../../core/domain.ts";
import { BackendApi, CLIENT_HEADER, LIMITS } from "../../core/historyApi.ts";
import { BackendRoutes, MIN_CLIENT } from "./Backend.ts";
import { GitHub } from "./GitHub.ts";
import { HistoryStore } from "./HistoryStore.ts";
import { PgMigrationsLive } from "./PgMigrations.ts";
import { PgTestLive } from "./testPostgres.ts";
import { commitRecord, threadRecord } from "./testRecords.ts";

const TestLive = HttpRouter.serve(BackendRoutes, {
  disableListenLog: true,
  disableLogger: true,
  routerConfig: { maxParamLength: 2048 },
}).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(
    // Two people GitHub knows: alex reads acme/app, sam reads nothing of ours.
    Layer.succeed(
      GitHub,
      GitHub.of({
        config: { clientId: "Iv1.test", apiUrl: "", webUrl: "https://github.com" },
        user: (token) =>
          Effect.succeed(
            token === "gho_alex"
              ? Option.some("alex")
              : token === "gho_sam"
                ? Option.some("sam")
                : Option.none(),
          ),
        canRead: (token, repo) => Effect.succeed(token === "gho_alex" && repo === "acme/app"),
      }),
    ),
  ),
  Layer.provideMerge(HistoryStore.layer),
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
  Effect.flatMap(HistoryStore, (s) => s.createToken(workspace, "test"));

const message = (id: string, text: string): Entry => ({
  type: "message",
  id,
  at: "2026-01-01T10:00:00.000Z",
  role: "user",
  text,
});

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
          [meta.apiVersion, meta.minClient, meta.formats],
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
              Effect.flip(api.history.hashes({ params: { ws }, payload: { ids: [] } })),
            ).pipe(Effect.map((e) => e._tag));
          assert.strictEqual(yield* tag(headers(null)), "Unauthorized");
          assert.strictEqual(yield* tag(headers("trk_nope")), "Unauthorized");
          assert.strictEqual(yield* tag(headers(good), "other"), "Forbidden");
          assert.strictEqual(yield* tag(headers(good, "0.0.1")), "UpgradeRequired");
          assert.strictEqual(yield* tag(headers(good, null)), "UpgradeRequired");
        }),
    );

    it.effect("stores a thread and a commit's links, and reads them back", () =>
      Effect.gen(function* () {
        const api = yield* clientWith(headers(yield* token("team")));
        const params = { ws: "team" };
        const thread = threadRecord("t1", [message("u1", "Add a")]);
        assert.deepStrictEqual(yield* api.history.putThread({ params, payload: thread }), {
          result: "inserted",
        });
        assert.deepStrictEqual(yield* api.history.putThread({ params, payload: thread }), {
          result: "same",
        });
        const { hashes } = yield* api.history.hashes({ params, payload: { ids: ["t1", "t2"] } });
        assert.deepStrictEqual(Object.keys(hashes), ["t1"]);
        yield* api.history.putCommit({ params, payload: commitRecord("abc1234", ["t1"]) });
        const { commits } = yield* api.history.commits({
          params: { ...params, repo: "acme/app" },
          payload: { shas: ["abc1234"] },
        });
        assert.deepStrictEqual(
          commits.map((c) => [c.sha, c.links.map((l) => l.threadId)]),
          [["abc1234", ["t1"]]],
        );
        const { threads } = yield* api.history.threads({ params, payload: { ids: ["t1"] } });
        assert.deepStrictEqual(
          threads.map((t) => t.thread.id),
          ["t1"],
        );
      }),
    );

    it.effect("rejects what isn't redacted or isn't a record (422), naming fields only", () =>
      Effect.gen(function* () {
        const api = yield* clientWith(headers(yield* token("checks")));
        const params = { ws: "checks" };
        const leaked = threadRecord("t1", [
          message("u1", "export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123"),
        ]);
        const rejected = yield* Effect.flip(api.history.putThread({ params, payload: leaked }));
        assert.deepStrictEqual(
          [
            rejected._tag,
            (rejected as { reason?: string }).reason,
            (rejected as { detail?: string }).detail,
          ],
          ["Rejected", "not-redacted", "the redactor would change entries.0.text"],
        );
        const future = yield* Effect.flip(
          api.history.putCommit({
            params,
            payload: { ...commitRecord("abc1234", []), formatVersion: 2 },
          }),
        );
        assert.strictEqual((future as { reason: string }).reason, "unsupported-format");
        const bad = yield* Effect.flip(
          api.history.putCommit({
            params,
            payload: { ...commitRecord("abc1234", []), sha: "XYZ" },
          }),
        );
        assert.strictEqual((bad as { reason: string }).reason, "invalid");
        // A repo name the reads couldn't take is refused when written.
        const long = yield* Effect.flip(
          api.history.putCommit({
            params,
            payload: { ...commitRecord("abc1234", []), repo: `acme/${"a".repeat(600)}` },
          }),
        );
        assert.strictEqual((long as { reason: string }).reason, "invalid");
      }),
    );

    it.effect("runs an agent's SQL over every conversation in its workspace, members' too", () =>
      Effect.gen(function* () {
        const machine = yield* clientWith(headers(yield* token("sql")));
        const params = { ws: "sql" };
        yield* machine.history.putThread({
          params,
          payload: threadRecord("t1", [message("u1", "Add a")]),
        });
        // Linked to no commit, in no repo: still readable by id.
        const query = "SELECT thread_id, turn, text FROM agent_entries WHERE thread_id = 't1'";
        assert.deepStrictEqual(yield* machine.history.sql({ params, payload: { query } }), {
          rows: [{ thread_id: "t1", turn: 1, text: "Add a" }],
          truncated: false,
        });
        // sam reads no repo of ours on GitHub, and still reads the workspace's conversations.
        yield* Effect.flatMap(HistoryStore, (s) => s.addMember("sql", "sam"));
        const sam = yield* clientWith(headers("gho_sam"));
        assert.strictEqual((yield* sam.history.sql({ params, payload: { query } })).rows.length, 1);
        const refused = yield* Effect.flip(
          machine.history.sql({ params, payload: { query: "SELECT * FROM threads" } }),
        );
        assert.strictEqual(refused._tag, "QueryRefused");
        assert.include(refused.message, "permission denied");
        const other = yield* Effect.flip(
          machine.history.sql({ params: { ws: "else" }, payload: { query } }),
        );
        assert.strictEqual(other._tag, "Forbidden");
      }),
    );

    it.effect("refuses a body over the limit before reading it (413)", () =>
      Effect.gen(function* () {
        const good = yield* token("big");
        const request = HttpClientRequest.put("/v1/workspaces/big/threads").pipe(
          HttpClientRequest.setHeaders(headers(good)),
          HttpClientRequest.bodyText("x".repeat(LIMITS.requestBytes + 1), "application/json"),
        );
        assert.strictEqual(yield* status(request), 413);
      }),
    );

    it.effect(
      "lets a GitHub member read and decide on the repos GitHub lets them read, and write nothing",
      () =>
        Effect.gen(function* () {
          const machine = yield* clientWith(headers(yield* token("gh")));
          yield* Effect.flatMap(HistoryStore, (s) => s.addMember("gh", "Alex"));
          yield* Effect.flatMap(HistoryStore, (s) => s.addMember("gh", "sam"));
          const params = { ws: "gh" };
          // A machine syncs, as today.
          yield* machine.history.putThread({
            params,
            payload: threadRecord("t1", [message("u1", "retries is undefined")]),
          });
          yield* machine.history.putCommit({ params, payload: commitRecord("abc1234", ["t1"]) });
          yield* machine.history.putCommit({
            params,
            payload: { ...commitRecord("def5678", ["t1"]), repo: "acme/secret" },
          });

          const alex = yield* clientWith(headers("gho_alex"));
          const app = { ...params, repo: "acme/app" };
          assert.deepStrictEqual(
            (yield* alex.history.commits({
              params: app,
              payload: { shas: ["abc1234"] },
            })).commits.map((c) => c.sha),
            ["abc1234"],
          );
          assert.strictEqual(
            (yield* alex.history.search({ params, payload: { text: "retries", repo: "acme/app" } }))
              .hits.length,
            1,
          );
          assert.strictEqual(
            (yield* alex.history.threads({ params, payload: { ids: ["t1"], repo: "acme/app" } }))
              .threads.length,
            1,
          );
          const tag = <A, E extends { _tag: string }>(e: Effect.Effect<A, E>) =>
            Effect.map(Effect.flip(e), (x) => x._tag);
          // A repo GitHub says no to, a read that names no repo, any write.
          assert.strictEqual(
            yield* tag(
              alex.history.commits({
                params: { ...params, repo: "acme/secret" },
                payload: { shas: ["def5678"] },
              }),
            ),
            "Forbidden",
          );
          assert.strictEqual(
            yield* tag(alex.history.search({ params, payload: { text: "retries" } })),
            "Forbidden",
          );
          assert.strictEqual(
            yield* tag(alex.history.threads({ params, payload: { ids: ["t1"] } })),
            "Forbidden",
          );
          assert.strictEqual(
            yield* tag(alex.history.putThread({ params, payload: threadRecord("t2", []) })),
            "Forbidden",
          );
          assert.strictEqual(
            yield* tag(alex.history.hashes({ params, payload: { ids: ["t1"] } })),
            "Forbidden",
          );

          // A member runs the detectors on a repo it reads; one GitHub says no to can't list them.
          yield* machine.history.putThread({
            params,
            payload: threadRecord("t3", [message("u3", "x")]),
          });
          yield* alex.history.detect({ params: app });
          const sam = yield* clientWith(headers("gho_sam"));
          assert.strictEqual(
            yield* tag(sam.history.findings({ params: app, payload: {} })),
            "Forbidden",
          );
          // Not a member, and not a GitHub user at all.
          yield* Effect.flatMap(HistoryStore, (s) => s.addMember("other", "alex"));
          const outsider = yield* clientWith(headers("gho_alex"));
          assert.strictEqual(
            yield* tag(
              outsider.history.findings({ params: { ws: "nope", repo: "acme/app" }, payload: {} }),
            ),
            "Forbidden",
          );
          // Removed from the pilot: refused at once.
          assert.isTrue(yield* Effect.flatMap(HistoryStore, (s) => s.removeMember("gh", "sam")));
          assert.strictEqual(
            yield* tag(sam.history.findings({ params: app, payload: {} })),
            "Forbidden",
          );
          const stranger = yield* clientWith(headers("gho_nobody"));
          assert.strictEqual(
            yield* tag(stranger.history.findings({ params: app, payload: {} })),
            "Unauthorized",
          );
          // An agent's finding must cite entries the repo's threads hold.
          const uncited = yield* Effect.flip(
            machine.history.submit({
              params: app,
              payload: {
                subject: "flaky retries",
                pattern: "sessions retry the same test",
                suggestion: "pin the seed",
                citations: [{ threadId: "nowhere", entryId: "e1", quote: "retries again" }],
              },
            }),
          );
          assert.deepStrictEqual(
            [uncited._tag, "message" in uncited ? uncited.message : ""],
            ["Conflict", "Citations that don't hold in acme/app's threads: nowhere#e1 (missing)"],
          );
          // How to sign in, without a token.
          const anonymous = yield* clientWith(headers(null, null));
          assert.deepStrictEqual(yield* anonymous.system.signIn(), {
            github: { clientId: "Iv1.test", webUrl: "https://github.com" },
          });
        }),
    );
  });
});
