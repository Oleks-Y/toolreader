import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";

import {
  privateTracer,
  traceMarkdown,
  withTracing,
  type TraceLevel,
  type TraceSpan,
} from "./Trace.ts";

const span = (id: string, parentId: string | null, name: string, start: number, end: number) =>
  ({ id, parentId, name, startMs: start, endMs: end, failed: false, attributes: [] }) as TraceSpan;

class Boom extends Schema.TaggedErrorClass<Boom>()("Boom", { message: Schema.String }) {}

const command = Effect.fn("toolreader test")(function* () {
  // As Effect's HTTP server span records a request.
  yield* Effect.annotateCurrentSpan({
    "http.request.method": "GET",
    "url.full": "http://127.0.0.1:4780/v1/workspaces/acme/threads/t1/checkpoints",
    "http.request.header.toolreader-client": "0.1.0",
    "client.address": "127.0.0.1",
    "http.response.status_code": 200,
  });
  yield* Effect.void.pipe(Effect.withSpan("sql.execute"), Effect.withSpan("Step.one"));
  yield* Effect.logWarning("No T3 database at /home/me/.t3");
  yield* new Boom({ message: "session text API_TOKEN=supersecret" }).pipe(
    Effect.withSpan("Step.two"),
    Effect.ignore,
  );
});

/** The spans `command` hands its sink at `level`: which are sampled, and how each ended. */
const traced = (level: TraceLevel) =>
  Effect.gen(function* () {
    const spans: Tracer.NativeSpan[] = [];
    const sink = Tracer.make({
      span(options) {
        const s = new Tracer.NativeSpan(options);
        spans.push(s);
        return s;
      },
    });
    yield* command().pipe(
      withTracing("test"),
      Effect.provideService(Tracer.Tracer, sink),
      Effect.provide(
        Layer.mergeAll(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { TOOLREADER_TRACE_LEVEL: level } })),
          NodeServices.layer,
        ),
      ),
    );
    return spans;
  });

describe("withTracing", () => {
  it.effect("keeps the spans the level asks for", () =>
    Effect.gen(function* () {
      const sampled = (spans: ReadonlyArray<Tracer.NativeSpan>) =>
        spans.filter((s) => s.sampled).map((s) => s.name);
      assert.deepStrictEqual(sampled(yield* traced("commands")), ["toolreader test"]);
      assert.deepStrictEqual(sampled(yield* traced("steps")), [
        "toolreader test",
        "Step.one",
        "Step.two",
      ]);
      assert.deepStrictEqual(sampled(yield* traced("all")), [
        "toolreader test",
        "Step.one",
        "sql.execute",
        "Step.two",
      ]);
    }),
  );

  it.effect("gives spans no failure detail and no logs", () =>
    Effect.gen(function* () {
      const spans = yield* traced("steps");
      const failed = spans.find((s) => s.name === "Step.two")!;
      assert.strictEqual(failed.status._tag, "Ended");
      const exit = failed.status._tag === "Ended" ? failed.status.exit : Exit.void;
      assert.isTrue(Exit.isFailure(exit));
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : null;
      assert.instanceOf(error, Error);
      assert.deepStrictEqual(
        [(error as Error).name, (error as Error).message, (error as Error).stack],
        ["Boom", "Boom", "Boom"],
      );
      // Logs stay out of spans: their text names paths.
      const root = spans.find((s) => s.name === "toolreader test")!;
      assert.deepStrictEqual(root.events, []);
      // So do URLs, headers and addresses.
      assert.deepStrictEqual(Object.fromEntries(root.attributes), {
        "http.request.method": "GET",
        "http.response.status_code": 200,
      });
    }),
  );
});

describe("privateTracer", () => {
  it.effect(
    "keeps a request's server span at level commands, though a caller's trace parents it",
    () =>
      Effect.gen(function* () {
        const spans: Tracer.NativeSpan[] = [];
        const sink = Tracer.make({
          span(options) {
            const s = new Tracer.NativeSpan(options);
            spans.push(s);
            return s;
          },
        });
        const caller = Tracer.externalSpan({
          traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
          spanId: "00f067aa0ba902b7",
          sampled: true,
        });
        yield* Effect.void.pipe(
          Effect.withSpan("Backend.put"),
          Effect.withSpan("http.server POST", { kind: "server", parent: caller }),
          Effect.provideService(Tracer.Tracer, privateTracer(sink, "commands")),
        );
        // Nor can a caller's unsampled flag hide the request.
        const quiet = Tracer.externalSpan({
          spanId: caller.spanId,
          traceId: "5bf92f3577b34da6a3ce929d0e0e4736",
          sampled: false,
        });
        yield* Effect.void.pipe(
          Effect.withSpan("http.server GET", { kind: "server", parent: quiet }),
          Effect.provideService(Tracer.Tracer, privateTracer(sink, "steps")),
        );
        assert.deepStrictEqual(
          spans.map((s) => [s.name, s.sampled, s.traceId]),
          [
            ["http.server POST", true, caller.traceId],
            ["Backend.put", false, caller.traceId],
            ["http.server GET", true, quiet.traceId],
          ],
        );
      }),
  );
});

describe("traceMarkdown", () => {
  it("draws who called whom, in call order, and when each step ran", () => {
    const md = traceMarkdown([
      span("b", "a", "Checkpoints.resolve", 1001, 1004),
      span("a", null, "Checkpoints.take", 1000, 1010),
      { ...span("c", "a", "CheckpointStore.put", 1005, 1009), failed: true },
      span("e", "c", "sql.execute", 1007, 1008),
      {
        ...span("d", "c", "sql.execute", 1006, 1007),
        attributes: [["db.statement", 'INSERT "x"; y']],
      },
    ]);
    assert.include(md, "# Trace (5 spans, 10 ms)");
    assert.include(md, "  s0 -->|1| s1\n  s0 -->|2| s2\n  s2 -->|1| s3");
    assert.include(md, "  section Checkpoints.take\n  Checkpoints.take :s0, 0, 10");
    assert.include(md, "  CheckpointStore.put :crit, s2, 5, 9\n  sql.execute ×2 :s3, 6, 8");
    assert.include(md, 's2["✗ CheckpointStore.put · 4.0 ms"]');
    // Merged siblings drop their attributes: one query's SQL would misdescribe the rest.
    assert.include(md, 's3["sql.execute ×2 · 2.0 ms"]');
  });
});
