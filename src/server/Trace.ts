// Tracing for every command (bin.ts `withTracing`), to two sinks, either or both:
// - `TOOLREADER_TRACE=trace.md` writes the command's spans, when it exits, as two Mermaid
//   diagrams: a gantt of when each step ran and a flowchart of which step called which. That is how
//   to see what the collection pipeline did, step by step, on real data.
// - OTLP/HTTP to a collector, with the standard variables, opted into explicitly (an endpoint set
//   for other tools in the shell doesn't send toolreader's spans anywhere):
//   `OTEL_TRACES_EXPORTER=otlp OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318`.
// `TOOLREADER_TRACE_LEVEL` sets how much: `commands`, `steps` (default) or `all` (`keepSpan`).
// Spans carry ids, counts and parameterized SQL, never session text, URLs or headers
// (`keepAttribute`); a failed span carries only
// its error's tag (`withoutDetail`), and logs don't become span events (they name paths). `traceMarkdown` and `keepSpan` are pure, for tests.
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as OtlpSerialization from "effect/unstable/observability/OtlpSerialization";
import * as OtlpTracer from "effect/unstable/observability/OtlpTracer";

export type TraceSpan = {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly failed: boolean;
  readonly attributes: ReadonlyArray<readonly [string, unknown]>;
};

const toTraceSpan = (s: Tracer.Span): TraceSpan => {
  const end = s.status._tag === "Ended" ? s.status : null;
  const parent = Option.getOrNull(s.parent);
  return {
    id: s.spanId,
    parentId: parent?.spanId ?? null,
    name: s.name,
    startMs: Number(s.status.startTime) / 1e6,
    endMs: Number(end?.endTime ?? s.status.startTime) / 1e6,
    failed: end !== null && end.exit._tag === "Failure",
    attributes: [...s.attributes],
  };
};

// Mermaid treats `:`, `;`, `#` and quotes as syntax; long SQL would swamp the diagram.
const label = (text: string, max = 60) => {
  const flat = text
    .replace(/[:;#"`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const ms = (n: number) => (n < 10 ? n.toFixed(1) : Math.round(n).toString());

/** Sibling spans of one name (a loop's SQL queries, one step per thread) drawn as one node. */
type Group = {
  readonly id: string;
  readonly name: string;
  readonly spans: ReadonlyArray<TraceSpan>;
  readonly children: ReadonlyArray<Group>;
};

export function traceMarkdown(spans: ReadonlyArray<TraceSpan>): string {
  const sorted = [...spans].sort((a, b) => a.startMs - b.startMs);
  const t0 = sorted[0]?.startMs ?? 0;
  const known = new Set(sorted.map((s) => s.id));
  const byParent = Map.groupBy(sorted, (s) =>
    s.parentId !== null && known.has(s.parentId) ? s.parentId : "",
  );
  let next = 0;
  const group = (siblings: ReadonlyArray<TraceSpan>): Group[] =>
    [...Map.groupBy(siblings, (s) => s.name)].map(([name, same]) => ({
      id: `s${next++}`,
      name,
      spans: same,
      children: group(same.flatMap((s) => byParent.get(s.id) ?? [])),
    }));
  const roots = group(byParent.get("") ?? []);
  const all: Group[] = [];
  const walk = (g: Group) => (all.push(g), g.children.forEach(walk));
  roots.forEach(walk);
  const failed = (g: Group) => g.spans.some((s) => s.failed);
  const times = (g: Group) => ({
    start: Math.round(Math.min(...g.spans.map((s) => s.startMs)) - t0),
    end: Math.round(Math.max(...g.spans.map((s) => s.endMs)) - t0),
    total: g.spans.reduce((n, s) => n + s.endMs - s.startMs, 0),
  });

  // A gantt section per top-level step: each row runs from its first span's start to its last's end.
  const gantt = ["gantt", "  dateFormat x", "  axisFormat %S.%L"];
  for (const root of roots) {
    gantt.push(`  section ${label(root.name, 40)}`);
    const rows: Group[] = [];
    const collect = (g: Group) => (rows.push(g), g.children.forEach(collect));
    collect(root);
    for (const g of rows) {
      const { start, end } = times(g);
      const n = g.spans.length > 1 ? ` ×${g.spans.length}` : "";
      gantt.push(
        `  ${label(g.name, 40)}${n} :${failed(g) ? "crit, " : ""}${g.id}, ${start}, ${Math.max(start + 1, end)}`,
      );
    }
  }

  const flow = ["flowchart TD"];
  for (const g of all) {
    const attrs =
      g.spans.length > 1
        ? []
        : g.spans[0]!.attributes.filter(([, v]) =>
            ["string", "number", "boolean"].includes(typeof v),
          )
            .map(([k, v]) => label(`${k}=${String(v)}`))
            .slice(0, 4);
    const n = g.spans.length > 1 ? ` ×${g.spans.length}` : "";
    const text = [`${label(g.name)}${n} · ${ms(times(g).total)} ms`, ...attrs].join("<br/>");
    flow.push(`  ${g.id}["${failed(g) ? "✗ " : ""}${text}"]`);
  }
  for (const g of all)
    for (const [i, c] of g.children.entries()) flow.push(`  ${g.id} -->|${i + 1}| ${c.id}`);

  return [
    `# Trace (${sorted.length} spans, ${ms(Math.max(t0, ...sorted.map((s) => s.endMs)) - t0)} ms)`,
    "",
    "```mermaid",
    ...gantt,
    "```",
    "",
    "```mermaid",
    ...flow,
    "```",
    "",
  ].join("\n");
}

export const TRACE_LEVELS = ["commands", "steps", "all"] as const;
export type TraceLevel = (typeof TRACE_LEVELS)[number];

/**
 * Whether a span is kept at `level`. `commands`: each command's root span (`toolreader ledger
 * sync`, or one per HTTP request under `serve`), for timing; `steps`: every step under it but
 * SQL statements; `all`: those too. A dropped span is unsampled, so its children drop with it.
 */
export const keepSpan = (
  level: TraceLevel,
  span: { readonly name: string; readonly root: boolean },
): boolean => level === "all" || (level === "steps" ? span.name !== "sql.execute" : span.root);

/**
 * Whether a span may carry this attribute. Effect's HTTP server span (`backend serve`, `serve`)
 * records the URL, every header, the user agent and the client's address: URLs name repos and
 * threads and headers can carry credentials, so those stay off; method and status stay.
 */
export const keepAttribute = (key: string): boolean =>
  !/^(url\.|http\.(request|response)\.header\.|user_agent\.|client\.address$)/.test(key);

/**
 * A span's end as the sinks get it: a failure keeps only its error's tag. Messages and stacks
 * can carry what spans must not: a schema error quotes the value it rejected (session text), a
 * stack has install paths under $HOME.
 */
export const withoutDetail = (exit: Exit.Exit<unknown, unknown>): Exit.Exit<unknown, unknown> => {
  if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return exit;
  const error = Cause.squash(exit.cause);
  const tag =
    Predicate.hasProperty(error, "_tag") && Predicate.isString(error._tag)
      ? error._tag
      : error instanceof Error
        ? error.name
        : "Error";
  const bare = new Error(tag);
  bare.name = tag;
  bare.stack = tag;
  return Exit.fail(bare);
};

/**
 * Spans kept per run. `serve` never ends, and each request opens spans: past this many the trace
 * file stops recording rather than grow without bound. ponytail: first N only; a ring buffer if
 * the end of a long run is what matters.
 */
const MAX_SPANS = 20_000;

const TraceConfig = Config.all({
  file: Config.option(Config.string("TOOLREADER_TRACE")),
  level: Config.schema(Schema.Literals(TRACE_LEVELS), "TOOLREADER_TRACE_LEVEL").pipe(
    Config.withDefault<TraceLevel>("steps"),
  ),
});

/**
 * The OTLP exporter when the OTEL_* variables ask for one; flushed when the command ends. The
 * service is `toolreader` unless OTEL_SERVICE_NAME names it (`toolreader-backend` for the backend),
 * so a collector tells the client's spans from the backend's.
 */
const otlp = (version: string) =>
  Layer.unwrap(
    Effect.map(
      Config.string("OTEL_SERVICE_NAME").pipe(Config.withDefault("toolreader")),
      (serviceName) =>
        OtlpTracer.layerFromConfig({ resource: { serviceName, serviceVersion: version } }),
    ),
  ).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(FetchHttpClient.layer));

/**
 * `delegate` with every span filtered to `level`, stripped of failure detail and of attributes
 * `keepAttribute` drops; `onSampled` sees each span it keeps.
 */
export const privateTracer = (
  delegate: Tracer.Tracer,
  level: TraceLevel,
  onSampled: (span: Tracer.Span) => void = () => {},
): Tracer.Tracer =>
  Tracer.make({
    span(options) {
      // A server span is a request's root even when it continues a caller's trace.
      const root = Option.isNone(options.parent) || options.kind === "server";
      // A request's span is kept whatever the caller's `traceparent` flags say: a caller can't
      // switch off the backend's record of its own requests (NFR-O4).
      const sampled =
        (options.kind === "server" || options.sampled) &&
        keepSpan(level, { name: options.name, root });
      const span = delegate.span({ ...options, sampled });
      if (sampled) onSampled(span);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => end(endTime, withoutDetail(exit));
      const attribute = span.attribute.bind(span);
      span.attribute = (key, value) => {
        if (keepAttribute(key)) attribute(key, value);
      };
      const event = span.event.bind(span);
      span.event = (name, startTime, attributes) =>
        event(
          name,
          startTime,
          attributes &&
            Object.fromEntries(Object.entries(attributes).filter(([key]) => keepAttribute(key))),
        );
      return span;
    },
    ...(delegate.context ? { context: delegate.context } : {}),
  });

/**
 * Runs `self` traced as the environment asks: spans filtered to the level, stripped of failure
 * detail, recorded for the trace file and passed on to the OTLP exporter or Effect's own tracer.
 */
export const withTracing =
  (version: string) =>
  <A, E, R>(
    self: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | Config.ConfigError, R | FileSystem.FileSystem> =>
    Effect.gen(function* () {
      const { file, level } = yield* TraceConfig;
      const delegate = yield* Tracer.Tracer;
      const loggers = yield* Logger.CurrentLoggers;
      const spans: Tracer.Span[] = [];
      const tracer = privateTracer(delegate, level, (span) => {
        if (Option.isSome(file) && spans.length < MAX_SPANS) spans.push(span);
      });
      const write = Option.match(file, {
        onNone: () => Effect.void,
        onSome: (path) =>
          Effect.flatMap(FileSystem.FileSystem, (fs) =>
            fs.writeFileString(path, traceMarkdown(spans.map(toTraceSpan))),
          ).pipe(Effect.ignore),
      });
      return yield* self.pipe(
        Effect.provideService(Tracer.Tracer, tracer),
        Effect.provideService(
          Logger.CurrentLoggers,
          new Set([...loggers].filter((l) => l !== Logger.tracerLogger)),
        ),
        Effect.ensuring(write),
      );
    }).pipe(Effect.provide(otlp(version)));
