import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { context, propagation, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { createRayfoldServer, listen } from "@rayfold/server";
import { createBookstore } from "../../../examples/bookstore-ts/src/index.ts";
import { rayfoldTracing } from "./index.ts";

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const tracer = provider.getTracer("test");
const contextManager = new AsyncLocalStorageContextManager();

beforeAll(() => {
  context.setGlobalContextManager(contextManager.enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
});
afterAll(() => {
  context.disable();
  propagation.disable();
});
const open: Server[] = [];
afterEach(async () => {
  exporter.reset();
  await Promise.all(open.splice(0).map((h) => new Promise<void>((r) => {
    h.close(() => r());
    h.closeAllConnections();
  })));
});

const spans = () => exporter.getFinishedSpans();
const named = (name: string): ReadableSpan => {
  const s = spans().find((x) => x.name === name);
  if (!s) throw new Error(`no span ${name} in ${spans().map((x) => x.name).join(", ")}`);
  return s;
};
const parentOf = (s: ReadableSpan) => s.parentSpanContext?.spanId;

describe("OpenTelemetry tracing", () => {
  it("a batch is a span with a child per op and a grandchild per loader call, all in one trace", async () => {
    const { server } = createBookstore({ instrumentation: rayfoldTracing({ tracer }) });
    const frames = await server.collect({
      ops: [
        { id: 1, op: "book", args: { id: "b1" }, shape: "{ title author { name } }" },
        { id: 2, op: "books", args: { page: { first: 2 } }, shape: "{ items { id author { name } } }" },
      ],
      meta: { client: "web" },
    });
    expect(frames.filter((f) => "error" in f)).toEqual([]);
    const batch = named("rayfold batch");
    const book = named("rayfold query book");
    const books = named("rayfold query books");
    const loads = spans().filter((s) => s.name === "rayfold load Book.author");
    expect(parentOf(batch)).toBeUndefined();
    expect([parentOf(book), parentOf(books)]).toEqual([batch.spanContext().spanId, batch.spanContext().spanId]);
    // Both ops need b1's author and a batch loads a row once, so which op pays for it depends on which asked first.
    // What is fixed: every load hangs under the op that asked, and together they cover the two authors, never three.
    const opSpans = [book.spanContext().spanId, books.spanContext().spanId];
    expect(loads.length).toBeGreaterThanOrEqual(1);
    expect(loads.every((s) => opSpans.includes(parentOf(s) ?? ""))).toBe(true);
    expect(loads.reduce((n, s) => n + Number(s.attributes["rayfold.parents"] ?? 0), 0)).toBe(2);
    expect(new Set(spans().map((s) => s.spanContext().traceId)).size).toBe(1);
    expect(batch.attributes).toMatchObject({ "rayfold.ops": 2, "rayfold.client": "web" });
    expect(book.attributes).toMatchObject({ "rayfold.op": "book", "rayfold.op.kind": "query", "rayfold.op.id": 1 });
    expect(loads[0]?.attributes).toMatchObject({ "rayfold.type": "Book" });
    expect(spans().every((s) => s.status.code !== SpanStatusCode.ERROR)).toBe(true);
  });

  it("a failed op is an error span with its code, its sibling stays fine, and an over-budget batch fails with no op spans", async () => {
    const { server } = createBookstore({ instrumentation: rayfoldTracing({ tracer }), budget: 10 });
    await server.collect({ ops: [{ id: 1, op: "book", args: {} }, { id: 2, op: "book", args: { id: "b1" }, shape: "{ id }" }] }); // op 1 lacks its id
    const bad = spans().find((s) => s.attributes["rayfold.op.id"] === 1);
    expect(bad?.status.code).toBe(SpanStatusCode.ERROR);
    expect(bad?.attributes["rayfold.error.code"]).toBe("invalid_argument");
    expect(spans().find((s) => s.attributes["rayfold.op.id"] === 2)?.status.code).not.toBe(SpanStatusCode.ERROR);
    exporter.reset();
    await server.collect({ ops: [{ id: 1, op: "books", args: { page: { first: 50 } } }] });
    expect(spans().map((s) => s.name)).toEqual(["rayfold batch"]);
    expect(named("rayfold batch").attributes["rayfold.error.code"]).toBe("resource_exhausted");
  });

  it("a traceparent header continues the caller's trace over HTTP", async () => {
    const { server } = createBookstore({ instrumentation: rayfoldTracing({ tracer }) });
    const http = await listen(server, 0);
    open.push(http);
    const res = await fetch(`http://127.0.0.1:${(http.address() as AddressInfo).port}/rayfold`, {
      method: "POST",
      headers: { "content-type": "application/rayfold+json", traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" },
      body: JSON.stringify({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id }" }] }),
    });
    await res.text();
    const batch = named("rayfold batch");
    expect(batch.spanContext().traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(parentOf(batch)).toBe("b7ad6b7169203331");
    expect(named("rayfold query book").spanContext().traceId).toBe("0af7651916cd43dd8448eb211c80319c");
  });

  it("trace context in the envelope's meta continues the caller's trace, tracestate included; a batch is a server span and each op span carries its cost", async () => {
    const { server } = createBookstore({ instrumentation: rayfoldTracing({ tracer }) });
    const ops = [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id }" }, { id: 2, op: "books", args: { page: { first: 2 } }, shape: "{ items { id } }" }];
    const frames = await server.collect({ ops, meta: { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01", tracestate: "vendor=opaque" } });
    const batch = named("rayfold batch");
    expect([batch.spanContext().traceId, parentOf(batch), batch.kind]).toEqual(["0af7651916cd43dd8448eb211c80319c", "b7ad6b7169203331", SpanKind.SERVER]);
    expect(batch.spanContext().traceState?.serialize()).toBe("vendor=opaque");
    const book = named("rayfold query book");
    const books = named("rayfold query books");
    // the cost on each span is the one the client is told in the op's frame
    expect(frames.map((f) => (f as { meta?: { cost?: number } }).meta?.cost)).toEqual([1, 8]);
    expect([book.kind, book.attributes["rayfold.cost"], books.attributes["rayfold.cost"]]).toEqual([SpanKind.INTERNAL, 1, 8]);

    // guard: a traceparent that does not parse is ignored, and the batch starts a trace of its own
    exporter.reset();
    await server.collect({ ops, meta: { traceparent: "00-not-a-trace-01", tracestate: "vendor=opaque" } });
    const fresh = named("rayfold batch");
    expect(parentOf(fresh)).toBeUndefined();
    expect(fresh.spanContext().traceId).not.toBe("0af7651916cd43dd8448eb211c80319c");
    expect(fresh.spanContext().traceState).toBeUndefined();
  });

  it("a resolver's own span nests under its loader span, and a loader that throws is an error span", async () => {
    const server = createRayfoldServer({
      schema: `entity A { id: ID b: B } entity B { id: ID } query a: A query broken: A`,
      instrumentation: rayfoldTracing({ tracer }),
      resolvers: {
        Query: { a: () => ({ id: "a1" }), broken: () => ({ id: "a2" }) },
        A: {
          b: async (parents: Array<{ id: string }>) => {
            if (parents[0]!.id === "a2") throw new Error("the database is down");
            return tracer.startActiveSpan("db select", async (s) => {
              s.end();
              return parents.map(() => ({ id: "b1" }));
            });
          },
        },
      },
    });
    await server.collect({ ops: [{ id: 1, op: "a", shape: "{ b { id } }" }] });
    expect(parentOf(named("db select"))).toBe(named("rayfold load A.b").spanContext().spanId);
    exporter.reset();
    await server.collect({ ops: [{ id: 1, op: "broken", shape: "{ b { id } }" }] });
    const load = named("rayfold load A.b");
    expect(load.status).toMatchObject({ code: SpanStatusCode.ERROR, message: "the database is down" });
    expect(load.events.map((e) => e.name)).toContain("exception");
    expect(named("rayfold query broken").status.code).toBe(SpanStatusCode.ERROR);
  });

  it("guard: without instrumentation nothing is recorded and the frames are the same", async () => {
    const batch = { ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ title author { name } }" }] };
    const traced = await createBookstore({ instrumentation: rayfoldTracing({ tracer }) }).server.collect(batch);
    exporter.reset();
    const plain = await createBookstore().server.collect(batch);
    expect(plain).toEqual(traced);
    expect(spans()).toEqual([]);
  });
});
