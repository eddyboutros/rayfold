import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { RbCodec } from "@rayfold/rb";
import { collect } from "./testing.ts";
import { loadSchema, schemaHash, type RayfoldSchemaIR } from "@rayfold/schema";
import { createRayfoldServer, listen, ok, type Frame, type RequestEnvelope, type RequestOp } from "@rayfold/server";
import { Signal, bounded } from "../../../e2e/wait.ts";
import { parseShapeText } from "@rayfold/schema";
import { bookstoreSchemaText, createBookstore } from "../../../examples/bookstore-ts/src/index.ts";
import { RayfoldCache } from "./cache.ts";
import { typeAtPath } from "./types.ts";
import { RayfoldClient, RayfoldClientError } from "./client.ts";
import { createFetchTransport, createLocalTransport, type Transport } from "./transport.ts";

type Bookstore = ReturnType<typeof createBookstore>;
let bs: Bookstore;
let viewer: unknown = { id: "u1", role: "customer" };
let client: RayfoldClient;
let keyN = 0;

beforeEach(() => {
  bs = createBookstore();
  viewer = { id: "u1", role: "customer" };
  keyN = 0;
  client = new RayfoldClient({ transport: createLocalTransport(bs.server, () => viewer), client: "test/1", keyGen: () => `key-${String(++keyN).padStart(12, "0")}` });
});

describe("cache", () => {
  it("normalizes entities once and denormalizes with refs resolved", () => {
    const c = new RayfoldCache(() => 0);
    const r = c.putResult("k", "books", { items: [{ $type: "Book", id: "b1", title: "T", author: { $type: "Author", id: "a1", name: "A" } }, { $type: "Book", id: "b1", title: "T" }] });
    expect(c.size).toBe(2);
    expect(r.keys).toEqual(new Set(["Book:b1", "Author:a1"]));
    expect(c.get("Book:b1")).toEqual({ $type: "Book", id: "b1", title: "T", author: { $ref: "Author:a1", $sel: { $type: true, id: true, name: true } } });
    // each occurrence reads back with exactly the fields it selected, values from the shared entity
    expect(c.denormalize(r.data)).toEqual({ items: [{ $type: "Book", id: "b1", title: "T", author: { $type: "Author", id: "a1", name: "A" } }, { $type: "Book", id: "b1", title: "T" }] });
    c.applyPatch([{ set: "Book:b1", value: { title: "T2" } }]);
    expect((c.denormalize(r.data) as { items: Array<{ title: string }> }).items.map((i) => i.title)).toEqual(["T2", "T2"]);
  });

  it("a deferred part keeps its aliased fields with the result, and its plain fields on the entity", () => {
    const c = new RayfoldCache(() => 0);
    const shape = parseShapeText("{ id @defer { x: title stock } }");
    c.putResult("k", "book", { $type: "Book", id: "b1" }, shape);
    c.mergeAt("k", "", { x: "T", stock: 4 }, shape);
    expect(c.denormalize(c.getResult("k")!.data)).toEqual({ $type: "Book", id: "b1", x: "T", stock: 4 });
    expect(c.get("Book:b1")).toEqual({ $type: "Book", id: "b1", stock: 4 }); // no field x on the book
  });

  it("applies set/del/inv/invOp patches and notifies affected ops", () => {
    const c = new RayfoldCache(() => 0);
    c.putResult("q1", "books", { items: [{ $type: "Book", id: "b1", stock: 5 }, { $type: "Book", id: "b2", stock: 1 }] });
    c.putResult("q2", "author", { $type: "Author", id: "a1" });
    const events: Array<{ keys: string[]; ops: string[] }> = [];
    c.subscribe((e) => events.push({ keys: [...e.keys].sort(), ops: [...e.ops].sort() }));
    c.applyPatch([{ set: "Book:b1", value: { stock: 3 } }, { del: "Book:b2" }, { inv: ["Author:a1"] }, { invOp: ["recommendations"] }]);
    expect(c.get("Book:b1")).toEqual({ $type: "Book", id: "b1", stock: 3 });
    expect(c.has("Book:b2")).toBe(false);
    expect(c.denormalize(c.getResult("q1")!.data)).toEqual({ items: [{ $type: "Book", id: "b1", stock: 3 }] });
    expect(c.isStale("Author:a1")).toBe(true);
    expect(events).toEqual([{ keys: ["Author:a1", "Book:b1", "Book:b2"], ops: ["author", "books", "recommendations"] }]);
  });
});

describe("client over the in-process transport", () => {
  it("queries and reads back denormalized data; the envelope carries the client name and deadline", async () => {
    const sent: RequestEnvelope[] = [];
    const local = createLocalTransport(bs.server, () => viewer);
    const c = new RayfoldClient({ transport: { send: (env, o) => (sent.push(env), local.send(env, o)) }, client: "test/1", deadline: 5000 });
    const book = await c.query<{ title: string; author: { name: string } }>("book", { id: "b1" }, { shape: "{ id title author { id name } }" });
    expect(book).toEqual({ $type: "Book", id: "b1", title: "The Dispossessed", author: { $type: "Author", id: "a1", name: "Ursula K. Le Guin" } });
    expect(sent).toEqual([{ rayfold: "0.1", ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id title author { id name } }" }], meta: { client: "test/1", deadline: 5000 } }]);
  });

  it("the same entity selected with other arguments, or through an alias, reads back what each result asked for", async () => {
    // a field asked for with arguments, or under an alias, was stored on the shared entity by its output name: the
    // later result overwrote the earlier one's, and a watcher of the first saw the second's answer
    const one = new Signal<number>();
    const stopOne = client.watch<{ reviews: { items: unknown[] } }>("book", { id: "b1" }, { shape: "{ id reviews(page: { first: 1 }) { items { id } } }" }, (d) => one.push(d.reviews.items.length));
    await one.atLeast(1, "the first page of one");
    const two = await client.query<{ reviews: { items: unknown[] } }>("book", { id: "b1" }, { shape: "{ id reviews(page: { first: 2 }) { items { id } } }" });
    expect(two.reviews.items).toHaveLength(2);
    expect(one.items.at(-1)).toBe(1);
    expect(await client.query<{ reviews: { items: unknown[] } }>("book", { id: "b1" }, { shape: "{ id reviews(page: { first: 1 }) { items { id } } }", policy: "cache" })).toEqual({ $type: "Book", id: "b1", reviews: { items: [{ $type: "Review", id: "r1" }] } });

    const named = await client.query<{ x: unknown }>("book", { id: "b1" }, { shape: "{ id x: title }" });
    const counted = await client.query<{ x: unknown }>("book", { id: "b1" }, { shape: "{ id x: stock }" });
    expect([named.x, counted.x]).toEqual(["The Dispossessed", 5]);
    expect(await client.query<{ x: unknown }>("book", { id: "b1" }, { shape: "{ id x: title }", policy: "cache" })).toEqual({ $type: "Book", id: "b1", x: "The Dispossessed" });
    expect(client.cache.get("Book:b1")).not.toHaveProperty("x"); // no entity has a field called x

    // guard: a plain field is still the entity's, shared by every result that selects it
    const stock = new Signal<number>();
    const stopStock = client.watch<{ stock: number }>("book", { id: "b1" }, { shape: "{ id stock }" }, (d) => stock.push(d.stock));
    await stock.atLeast(1, "the stock");
    await client.command("placeOrder", { input: { lines: [{ bookId: "b1", qty: 1 }] } });
    await stock.atLeast(2, "the stock after the order");
    expect(stock.items).toEqual([5, 4]);
    stopOne();
    stopStock();
  });

  it("a dry run answers with what would happen and changes nothing a watcher sees; the real run does", async () => {
    viewer = { id: "u9", role: "admin" }; // restock is staff-only, and declares @simulate
    const watched = new Signal<number>();
    const stop = client.watch<{ id: string; stock: number }>("book", { id: "b1" }, { shape: "{ id stock }" }, (d) => watched.push(d.stock));
    await watched.atLeast(1, "the book as the cache holds it");
    const dry = await client.command<{ stock: number }>("restock", { bookId: "b1", qty: 100 }, { shape: "{ id stock }", simulate: true });
    expect(dry).toEqual({ $type: "Book", id: "b1", stock: 105 }); // what the restock would leave
    expect(watched.items).toEqual([5]); // written to the cache, it showed 105 as if it had happened
    expect(await client.query<{ stock: number }>("book", { id: "b1" }, { shape: "{ id stock }", policy: "cache" })).toEqual({ $type: "Book", id: "b1", stock: 5 });
    // guard: the same command for real updates the cache, and the watcher with it
    await client.command("restock", { bookId: "b1", qty: 100 }, { shape: "{ id stock }" });
    await watched.atLeast(2, "the real restock");
    expect(watched.items).toEqual([5, 105]);
    stop();
  });

  it("commands apply patches so an earlier query result updates without a refetch", async () => {
    const watched = new Signal<number>();
    const seen = watched.items;
    const stop = client.watch<{ items: Array<{ id: string; stock: number }> }>("books", { page: { first: 2 } }, { shape: "{ items { id stock } }" }, (d) => watched.push(d.items[0]!.stock));
    await watched.atLeast(1, "initial watch result");
    expect(seen).toEqual([5]);
    const order = await client.command<{ id: string; status: string }>("placeOrder", { input: { lines: [{ bookId: "b1", qty: 2 }] } });
    expect(order).toMatchObject({ $type: "Order", id: "o1", status: "PLACED" });
    expect(seen).toEqual([5, 3]);
    expect(bs.store.calls["Query.books"]).toBe(1);
    stop();
    const cached = await client.query<{ items: Array<{ stock: number }> }>("books", { page: { first: 2 } }, { shape: "{ items { id stock } }", policy: "cache" });
    expect(cached.items[0]!.stock).toBe(3);
    expect(bs.store.calls["Query.books"]).toBe(1);
  });

  it("a command's answer is not kept as a result, so commands with new arguments do not pile up; guard: a query's is", async () => {
    viewer = { id: "u9", role: "admin" };
    const shape = { shape: "{ id stock }" };
    for (const qty of [1, 2, 3]) {
      expect(await client.command("restock", { bookId: "b1", qty }, shape)).toEqual({ $type: "Book", id: "b1", stock: 5 + (qty * (qty + 1)) / 2 });
      expect(client.cache.getResult(RayfoldCache.resultKey("restock", { bookId: "b1", qty }, shape.shape, undefined))).toBeUndefined();
    }
    expect(client.cache.get("Book:b1")).toEqual({ $type: "Book", id: "b1", stock: 11 });
    // an optimistic command still answers with the server's value once its prediction is gone
    expect(await client.command("restock", { bookId: "b1", qty: 4 }, { ...shape, optimistic: [{ set: "Book:b1", value: { stock: 99 } }] })).toEqual({ $type: "Book", id: "b1", stock: 15 });
    await client.query("book", { id: "b1" }, shape);
    const kept = client.cache.getResult(RayfoldCache.resultKey("book", { id: "b1" }, shape.shape, undefined));
    expect(kept && { op: kept.op, keys: [...kept.keys], data: client.cache.denormalize(kept.data) }).toEqual({ op: "book", keys: ["Book:b1"], data: { $type: "Book", id: "b1", stock: 15 } });
  });

  it("batches with refs: create then read in one round trip", async () => {
    const b = client.batch();
    const placed = b.command<{ id: string }>("placeOrder", { input: { lines: [{ bookId: "b3", qty: 1 }] } });
    const read = b.query<{ id: string; total: string }>("order", { id: placed.ref("id") }, { shape: "{ id total }" });
    const { frames } = await b.run();
    expect(frames).toHaveLength(2);
    expect((await placed.promise).id).toBe("o1");
    expect(await read.promise).toEqual({ $type: "Order", id: "o1", total: "8.00" });
    expect(placed.req.key).toBe("key-000000000001");
  });

  it("typed domain errors surface as RayfoldClientError with data", async () => {
    const err = await client.command("placeOrder", { input: { lines: [{ bookId: "b4", qty: 1 }] } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RayfoldClientError);
    const e = err as RayfoldClientError;
    expect(e.is("OutOfStock")).toBe(true);
    expect(e.data).toEqual({ bookId: "b4", available: 0 });
    expect(e.retryable).toBe(false);
  });

  it("dependent op fails when its reference failed; the other handle still resolves independently", async () => {
    const b = client.batch();
    const bad = b.command("placeOrder", { input: { lines: [{ bookId: "b4", qty: 1 }] } });
    const dep = b.query("order", { id: bad.ref("id") });
    const fine = b.query<{ id: string }>("book", { id: "b1" }, { shape: "{ id }" });
    await b.run();
    await expect(bad.promise).rejects.toMatchObject({ code: "domain", type: "OutOfStock" });
    await expect(dep.promise).rejects.toMatchObject({ code: "failed_precondition", type: "DependencyFailed" });
    expect(await fine.promise).toEqual({ $type: "Book", id: "b1" });
  });

  it("deferred frames fill the result before the promise resolves", async () => {
    const author = await client.query<{ name: string; bio: string }>("author", { id: "a1" }, { shape: "{ id name bio }" });
    expect(author).toEqual({ $type: "Author", id: "a1", name: "Ursula K. Le Guin", bio: "American author of speculative fiction." });
  });

  it("streams items and stops on abort", async () => {
    const ac = new AbortController();
    const items = new Signal<unknown>();
    const subscribed = new Signal<string>();
    const on = bs.server.events.on.bind(bs.server.events);
    vi.spyOn(bs.server.events, "on").mockImplementation((name, fn) => {
      const off = on(name, fn);
      subscribed.push(name);
      return off;
    });
    const consumer = (async () => {
      for await (const it of client.stream("stockUpdates", { bookIds: ["b1"] }, { signal: ac.signal })) items.push(it);
    })();
    await subscribed.until((names) => names.includes("StockChanged"), "stream subscribed to StockChanged");
    viewer = { id: "u9", role: "admin" };
    await client.command("restock", { bookId: "b2", qty: 1 }); // not in the stream's bookIds
    await client.command("restock", { bookId: "b1", qty: 4 });
    await items.atLeast(1, "stream item");
    ac.abort();
    await bounded(consumer, "stream ended on abort");
    expect(items.items).toEqual([{ bookId: "b1", stock: 9 }]);
  });

  it("a stream that fails throws the error frame; a cancel it did not ask for is a failure too", async () => {
    const drain = async (items: AsyncIterable<unknown>) => {
      const got: unknown[] = [];
      try {
        for await (const x of items) got.push(x);
      } catch (e) {
        return { got, error: { name: (e as Error).name, code: (e as RayfoldClientError).code, message: (e as Error).message } };
      }
      return { got, error: null };
    };
    expect(await bounded(drain(client.stream("stockUpdates", {})), "the refused stream")).toEqual({ got: [], error: { name: "RayfoldClientError", code: "invalid_argument", message: "stockUpdates().bookIds: required" } });
    const canceled: Transport = {
      send: async function* () {
        yield { id: 1, item: { bookId: "b1", stock: 1 } } as Frame;
        yield { id: 1, error: { code: "canceled", message: "Canceled by the server" }, fin: true } as Frame;
      },
    };
    const c = new RayfoldClient({ transport: canceled });
    expect(await drain(c.stream("stockUpdates", { bookIds: ["b1"] }))).toEqual({ got: [{ bookId: "b1", stock: 1 }], error: { name: "RayfoldClientError", code: "canceled", message: "Canceled by the server" } });
  });

  it("an op the transport ends without answering is rejected as unavailable; the answered one resolves", async () => {
    const partial: Transport = {
      send: async function* () {
        yield { id: 1, data: { $type: "Book", id: "b1" }, fin: true } as Frame;
      },
    };
    const b = new RayfoldClient({ transport: partial }).batch();
    const answered = b.query("book", { id: "b1" });
    const dropped = b.query("book", { id: "b2" });
    await b.run();
    expect(await answered.promise).toEqual({ $type: "Book", id: "b1" });
    const err = await bounded(dropped.promise.catch((e: unknown) => e), "the unanswered op settled");
    expect(err).toBeInstanceOf(RayfoldClientError);
    expect({ code: (err as RayfoldClientError).code, message: (err as Error).message }).toEqual({ code: "unavailable", message: "Batch ended without a result for this op" });
  });

  it("batch-level errors reject every handle", async () => {
    const b = client.batch();
    const h1 = b.query("book", { id: { $ref: "2.id" } });
    const h2 = b.query("book", { id: "b1" });
    await b.run();
    await expect(h1.promise).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(h2.promise).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("a live patch's `at` onto an entity follows the op's shape: an aliased field stays with the result, an own field reaches the entity", async () => {
    const live: Transport = {
      send: async function* () {
        yield { id: 1, data: { featured: { $type: "Book", id: "b1", x: "Dune", stock: 3 } } } as Frame;
        yield { id: 1, patch: [{ at: "featured", value: { x: "Dune (1965)", stock: 5 } }] } as Frame;
        yield { id: 1, fin: true } as Frame;
      },
    };
    const c = new RayfoldClient({ transport: live });
    const data = await bounded(c.query("shelf", {}, { shape: "{ featured { id x: title stock } }" }), "the patched query");
    expect(data).toEqual({ featured: { $type: "Book", id: "b1", x: "Dune (1965)", stock: 5 } });
    expect(c.cache.get("Book:b1")).toEqual({ $type: "Book", id: "b1", stock: 5 });
  });
});

describe("a live query with a deferred part", () => {
  type Author = { $type: string; id: string; name: string; bio?: string };
  const follow = (shape: string) =>
    collect<Author>((next, fail) => client.live<Author>("author", { id: "a1" }, { shape }, next, fail));

  it("reports the deferred part when it arrives, not only after the next change", async () => {
    const author = follow("{ id name bio }");
    expect(await author.next("the result before its deferred part")).toEqual({ $type: "Author", id: "a1", name: "Ursula K. Le Guin" });
    expect(await author.next("the deferred bio")).toEqual({
      $type: "Author",
      id: "a1",
      name: "Ursula K. Le Guin",
      bio: "American author of speculative fiction.",
    });
    author.stop();
    expect(author.values).toHaveLength(2);
  });

  it("guard: a live query with nothing deferred reports its result once, and nothing more until a change", async () => {
    const author = follow("{ id name }");
    expect(await author.next("the result")).toEqual({ $type: "Author", id: "a1", name: "Ursula K. Le Guin" });
    await expect(author.next("a second report", 300)).rejects.toThrow(/no value within 300 ms/);
    author.stop();
    expect(author.values).toHaveLength(1);
  });
});

describe("client over HTTP", () => {
  let http: Server;
  let url: string;
  let store: Bookstore;
  beforeEach(async () => {
    store = createBookstore();
    http = await listen(store.server, 0, { viewer: (req) => (req.headers.authorization ? { id: req.headers.authorization.slice(7), role: "customer" } : null) });
    url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/rayfold`;
  });
  afterEach(() => new Promise<void>((r) => {
    http.close(() => r());
    http.closeAllConnections();
  }));

  it("streams NDJSON frames through fetch and applies patches", async () => {
    const c = new RayfoldClient({ transport: createFetchTransport({ url, headers: () => ({ authorization: "Bearer u1" }) }) });
    const first = await c.query<{ stock: number }>("book", { id: "b3" }, { shape: "{ id stock }" });
    expect(first.stock).toBe(100);
    await c.command("placeOrder", { input: { lines: [{ bookId: "b3", qty: 5 }] } });
    expect(c.cache.get("Book:b3")).toMatchObject({ stock: 95 });
    const deferred = await c.query<{ bio: string }>("author", { id: "a1" }, { shape: "{ id bio }" });
    expect(deferred).toEqual({ $type: "Author", id: "a1", bio: "American author of speculative fiction." });
  });

  const manifestOf = async () => (await (await fetch(url + "/manifest")).json()) as { schema: RayfoldSchemaIR; schemaHash: string };
  const bookB1 = { ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ title stock author { name } }" }] };
  const collect = async (t: Transport, env: RequestEnvelope) => {
    const out: Frame[] = [];
    for await (const f of t.send(env)) out.push(f);
    return out;
  };

  it("speaks RB once the server's schema hash matches the manifest's: the same frames as JSON in fewer bytes", async () => {
    const manifest = await manifestOf();
    const wire: Array<{ sent: string | null; got: string | null; bytes: number }> = [];
    const recording: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      wire.push({ sent: new Headers(init?.headers).get("content-type"), got: res.headers.get("content-type"), bytes: (await res.clone().arrayBuffer()).byteLength });
      return res;
    };
    const auth = () => ({ authorization: "Bearer u1" });
    const rbTransport = createFetchTransport({ url, binary: manifest, fetch: recording, headers: auth });
    const jsonTransport = createFetchTransport({ url, fetch: recording, headers: auth });
    const env = { ops: [{ id: 1, op: "books", args: { page: { first: 3 } }, shape: "{ items { id title author { id name } } }" }] };
    const first = await collect(rbTransport, env); // the server's hash is not known yet, so this one is JSON
    const viaRb = await collect(rbTransport, env);
    const viaJson = await collect(jsonTransport, env);
    expect(first).toEqual(viaJson);
    expect(viaRb).toEqual(viaJson);
    expect((viaRb[0] as { data: { items: Array<{ author: { name: string } }> } }).data.items[0]!.author.name).toBe("Ursula K. Le Guin");
    expect(wire.map((w) => [w.sent, w.got])).toEqual([
      ["application/rayfold+json", "application/rayfold-frames+json"],
      ["application/rayfold", "application/rayfold"],
      ["application/rayfold+json", "application/rayfold-frames+json"],
    ]);
    expect(wire[1]!.bytes).toBeLessThan(wire[2]!.bytes);
    // a command and its patches over RB land in the cache like JSON ones
    const c = new RayfoldClient({ transport: rbTransport });
    const order = await c.command<{ status: string }>("placeOrder", { input: { lines: [{ bookId: "b1", qty: 1 }] } });
    expect(order.status).toBe("PLACED");
    expect(wire.at(-1)!.sent).toBe("application/rayfold");
    expect(c.cache.get("Book:b1")).toMatchObject({ stock: 4 });
  });

  it("stays on JSON when the client's schema is not the server's, so no field is read under another's name", async () => {
    const manifest = await manifestOf();
    const drifted = loadSchema(bookstoreSchemaText().replace("  name: String\n", "  name: String\n  nickname: String?\n")).ir;
    const sent: Array<string | null> = [];
    const recording: typeof fetch = (input, init) => {
      sent.push(new Headers(init?.headers).get("content-type"));
      return fetch(input, init);
    };
    const t = createFetchTransport({ url, binary: drifted, fetch: recording });
    for (let i = 0; i < 3; i++) {
      expect((await collect(t, bookB1))[0]).toMatchObject({ data: { title: "The Dispossessed", author: { name: "Ursula K. Le Guin" } } });
    }
    expect(sent).toEqual(["application/rayfold+json", "application/rayfold+json", "application/rayfold+json"]);

    // guard: this drift is one that misreads fields when RB is used regardless of the hash
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/rayfold", accept: "application/rayfold", "rayfold-safe": "true" }, body: new RbCodec(manifest.schema).encode(bookB1) as BodyInit });
    expect(JSON.stringify(new RbCodec(drifted).decodeFrames(new Uint8Array(await res.arrayBuffer())))).not.toContain('"title":"The Dispossessed"');
    // and the manifest's schema on its own hashes differently from the server's, which is why the transport takes the manifest
    expect(schemaHash(manifest.schema)).not.toBe(manifest.schemaHash);
  });

  it("refuses an RB answer that comes with another schema hash, and sends the next request as JSON", async () => {
    const manifest = await manifestOf();
    const sent: Array<string | null> = [];
    let redeployed = false;
    // stands in for a deploy between two requests: this one answer reports a schema the client does not hold
    const deploying: typeof fetch = async (input, init) => {
      sent.push(new Headers(init?.headers).get("content-type"));
      const res = await fetch(input, init);
      if (!redeployed) return res;
      redeployed = false;
      const headers = new Headers(res.headers);
      headers.set("rayfold-schema", "0".repeat(64));
      return new Response(res.body, { status: res.status, headers });
    };
    const t = createFetchTransport({ url, binary: manifest, fetch: deploying });
    await collect(t, bookB1);
    redeployed = true;
    expect(await collect(t, bookB1)).toMatchObject([{ error: { code: "unavailable" }, fin: true }]);
    expect((await collect(t, bookB1))[0]).toMatchObject({ data: { title: "The Dispossessed" } });
    expect((await collect(t, bookB1))[0]).toMatchObject({ data: { title: "The Dispossessed" } });
    expect(sent).toEqual(["application/rayfold+json", "application/rayfold", "application/rayfold+json", "application/rayfold"]);
  });

  it("a schema-aware client sends compact ops, restores $type, and moves fewer bytes than plain JSON", async () => {
    const manifest = (await (await fetch(url + "/manifest")).json()) as { schema: import("@rayfold/schema").RayfoldSchemaIR };
    let bytes = 0;
    const counting: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      const text = await res.clone().text();
      bytes += Buffer.byteLength(text);
      return res;
    };
    const c = new RayfoldClient({ transport: createFetchTransport({ url, fetch: counting, headers: () => ({ authorization: "Bearer u1" }) }), schema: manifest.schema });
    const books = await c.query<{ items: Array<{ $type: string; id: string; author: { $type: string; name: string } }> }>("books", { page: { first: 3 } }, { shape: "{ items { id title author { id name } } }" });
    expect(books.items[0]).toMatchObject({ $type: "Book", id: "b1", author: { $type: "Author", name: "Ursula K. Le Guin" } });
    expect(c.cache.get("Author:a1")).toMatchObject({ name: "Ursula K. Le Guin" });
    const compactBytes = bytes;
    bytes = 0;
    const plain = new RayfoldClient({ transport: createFetchTransport({ url, fetch: counting, headers: () => ({ authorization: "Bearer u1" }) }) });
    await plain.query("books", { page: { first: 3 } }, { shape: "{ items { id title author { id name } } }" });
    expect(compactBytes).toBeLessThan(bytes);
    const author = await c.query<{ $type: string; bio: string }>("author", { id: "a1" }, { shape: "{ id name bio }" });
    expect(author).toEqual({ $type: "Author", id: "a1", name: "Ursula K. Le Guin", bio: "American author of speculative fiction." });
    const order = await c.command<{ $type: string; items: Array<{ book: { $type: string } }> }>("placeOrder", { input: { lines: [{ bookId: "b3", qty: 1 }] } });
    expect(order.$type).toBe("Order");
    expect(order.items[0]!.book.$type).toBe("Book");
  });

  it("an all-query batch goes as a safe request, over QUERY when asked; a batch holding a command does not", async () => {
    const manifest = await manifestOf();
    const sent: Array<{ method: string | undefined; safe: string | null }> = [];
    const recording: typeof fetch = (input, init) => {
      sent.push({ method: init?.method, safe: new Headers(init?.headers).get("rayfold-safe") });
      return fetch(input, init);
    };
    const auth = () => ({ authorization: "Bearer u1" });
    const clientOf = (o: { useQueryMethod?: boolean; schema?: RayfoldSchemaIR }) =>
      new RayfoldClient({ transport: createFetchTransport({ url, fetch: recording, headers: auth, ...(o.useQueryMethod ? { useQueryMethod: true } : {}) }), ...(o.schema ? { schema: o.schema } : {}) });
    const reads = async (c: RayfoldClient) => {
      const b = c.batch();
      const one = b.query<{ id: string }>("book", { id: "b1" }, { shape: "{ id }" });
      const two = b.query<{ id: string }>("book", { id: "b2" }, { shape: "{ id }" });
      await b.run();
      return [(await one.promise).id, (await two.promise).id];
    };
    const mixed = async (c: RayfoldClient) => {
      const b = c.batch();
      const read = b.query<{ id: string }>("book", { id: "b1" }, { shape: "{ id }" });
      const placed = b.command<{ status: string }>("placeOrder", { input: { lines: [{ bookId: "b3", qty: 1 }] } }, { shape: "{ id status }" });
      await b.run();
      return [(await read.promise).id, (await placed.promise).status];
    };
    for (const c of [clientOf({ schema: manifest.schema }), clientOf({ schema: manifest.schema, useQueryMethod: true })]) {
      expect(await reads(c)).toEqual(["b1", "b2"]);
      expect(await mixed(c)).toEqual(["b1", "PLACED"]);
    }
    // without a schema the client cannot tell a query from a command, so nothing is claimed safe
    expect(await reads(clientOf({}))).toEqual(["b1", "b2"]);
    expect(sent).toEqual([
      { method: "POST", safe: "true" },
      { method: "POST", safe: null },
      { method: "QUERY", safe: null },
      { method: "POST", safe: null },
      { method: "POST", safe: null },
    ]);
  });

  it("a live query never goes as a safe request, so a server that buffers safe requests still streams it; a plain query still does", async () => {
    const manifest = await manifestOf();
    const sent: Array<string | null> = [];
    const recording: typeof fetch = (input, init) => {
      sent.push(new Headers(init?.headers).get("rayfold-safe"));
      return fetch(input, init);
    };
    const c = new RayfoldClient({ transport: createFetchTransport({ url, fetch: recording }), schema: manifest.schema });
    const seen = new Signal<number>();
    const stop = c.live<{ stock: number }>("book", { id: "b1" }, { shape: "{ id stock }" }, (d) => seen.push(d.stock));
    await seen.atLeast(1, "the first result");
    await store.server.collect({ ops: [{ id: 1, op: "restock", args: { bookId: "b1", qty: 1 }, key: "0123456789abcdef" }] }, { viewer: { id: "u9", role: "admin" } });
    expect(await seen.atLeast(2, "the change")).toEqual([5, 6]);
    stop();
    expect(await c.query<{ id: string }>("book", { id: "b2" }, { shape: "{ id }" })).toEqual({ $type: "Book", id: "b2" }); // guard: a plain query is still safe
    expect(sent).toEqual([null, "true"]);
  });

  for (const binary of [false, true]) it(`a consumer leaving a stream early drops its response and the server's stream; one still reading keeps its own, and its abort ends it quietly (RB: ${binary})`, async () => {
    const listening = new Signal<"on" | "off">();
    const on = store.server.events.on.bind(store.server.events);
    vi.spyOn(store.server.events, "on").mockImplementation((name, fn) => {
      const off = on(name, fn);
      listening.push("on");
      return () => {
        off();
        listening.push("off");
      };
    });
    const count = (x: string) => (xs: string[]) => xs.filter((y) => y === x).length;
    const kinds: string[] = [];
    const recording: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      kinds.push(res.headers.get("content-type") ?? "");
      return res;
    };
    const c = new RayfoldClient({ transport: createFetchTransport({ url, fetch: recording, headers: () => ({ authorization: "Bearer u1" }), ...(binary ? { binary: await manifestOf() } : {}) }) });
    if (binary) await c.query("book", { id: "b1" }, { shape: "{ id }" }); // learns the server's schema hash
    // from here on: the setup's own requests are not the streams'
    const responses = new Signal<"open" | "closed">();
    http.on("request", (_req, res) => {
      responses.push("open");
      res.on("close", () => responses.push("closed"));
    });
    const admin = new RayfoldClient({ transport: createLocalTransport(store.server, () => ({ id: "u9", role: "admin" })) });

    const left = new Signal<unknown>();
    const leaving = (async () => {
      for await (const x of c.stream("stockUpdates", { bookIds: ["b1"] })) {
        left.push(x);
        break;
      }
    })();
    const kept = new Signal<unknown>();
    const ac = new AbortController();
    const keeping = (async () => {
      for await (const x of c.stream("stockUpdates", { bookIds: ["b1"] }, { signal: ac.signal })) kept.push(x);
      return "ended";
    })();
    await listening.until((xs) => count("on")(xs) === 2, "both streams subscribed");
    await admin.command("restock", { bookId: "b1", qty: 1 });
    await bounded(leaving, "the consumer that broke out");
    await responses.until((xs) => count("closed")(xs) === 1, "the left stream's response closed");
    await listening.until((xs) => count("off")(xs) === 1, "the left stream's subscription dropped on the server");

    // guard: the stream still being read is untouched
    await admin.command("restock", { bookId: "b1", qty: 1 });
    await kept.atLeast(2, "the kept stream's second item");
    expect(left.items).toEqual([{ bookId: "b1", stock: 6 }]);
    expect(kept.items).toEqual([{ bookId: "b1", stock: 6 }, { bookId: "b1", stock: 7 }]);
    expect(count("closed")(responses.items)).toBe(1);
    expect(kinds.slice(-2)).toEqual(binary ? ["application/rayfold", "application/rayfold"] : ["application/rayfold-frames+json", "application/rayfold-frames+json"]);

    ac.abort();
    expect(await bounded(keeping, "the aborted stream")).toBe("ended");
    await listening.until((xs) => count("off")(xs) === 2, "the aborted stream's subscription dropped");
  });

  it("a stream whose frames stop without fin fails as unavailable; guard: one that ends with fin completes", async () => {
    const drain = async (items: AsyncIterable<unknown>) => {
      const got: unknown[] = [];
      try {
        for await (const x of items) got.push(x);
      } catch (e) {
        return { got, error: (e as RayfoldClientError).code };
      }
      return { got, error: null };
    };
    const cut: Transport = {
      send: async function* () {
        yield { id: 1, item: 1 } as Frame;
      },
    };
    const whole: Transport = {
      send: async function* () {
        yield { id: 1, item: 1 } as Frame;
        yield { id: 1, fin: true } as Frame;
      },
    };
    expect(await drain(new RayfoldClient({ transport: cut }).stream("ticks"))).toEqual({ got: [1], error: "unavailable" });
    expect(await drain(new RayfoldClient({ transport: whole }).stream("ticks"))).toEqual({ got: [1], error: null });
  });

  it("reads frames split anywhere across chunks, and a last frame with no newline after it", async () => {
    const text = '{"id":1,"data":{"$type":"Book","id":"b1","title":"T\u00e9"}}\n\n{"id":1,"fin":true}';
    const bytes = new TextEncoder().encode(text);
    const e = bytes.indexOf(0xc3); // the first of the two bytes that encode the accented letter
    const chunked: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            // split inside that two-byte letter, and inside the second frame
            for (const [from, to] of [[0, e + 1], [e + 1, e + 30], [e + 30, bytes.length]] as const) c.enqueue(bytes.slice(from, to));
            c.close();
          },
        }),
        { headers: { "content-type": "application/rayfold-frames+json" } },
      );
    const c = new RayfoldClient({ transport: createFetchTransport({ url: "http://rayfold.invalid/rayfold", fetch: chunked }) });
    expect(await c.query("book", { id: "b1" })).toEqual({ $type: "Book", id: "b1", title: "T\u00e9" });
  });

  it("maps HTTP problem responses to errors", async () => {
    const c = new RayfoldClient({ transport: createFetchTransport({ url: url + "/nope" }) });
    await expect(c.query("book", { id: "b1" })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("deleting an entity through the real command pipeline", () => {
  const author = { id: "u1", role: "customer" };
  const page = { shape: "{ id title reviews { items { id rating } } }" };

  for (const compact of [false, true]) {
    it(`removes it from lists nested inside other cached entities (compact: ${compact})`, async () => {
      const store = createBookstore();
      const manifest = compact ? { schema: store.server.ir } : {};
      const c = new RayfoldClient({ transport: createLocalTransport(store.server, () => author), ...manifest });
      // two cached pages: b2 lists r2 (the one being deleted), b1 lists r1 and r4 (must be untouched)
      const b2 = await c.query<{ reviews: { items: Array<{ id: string }> } }>("book", { id: "b2" }, page);
      const b1 = await c.query<{ reviews: { items: Array<{ id: string }> } }>("book", { id: "b1" }, page);
      expect(b2.reviews.items.map((r) => r.id)).toEqual(["r2"]);
      expect(b1.reviews.items.map((r) => r.id)).toEqual(["r1", "r4"]);
      const notified: string[][] = [];
      c.cache.subscribe((e) => notified.push([...e.keys].sort()));

      await c.command("deleteReview", { id: "r2" }, { shape: "{ id }" });

      const b2After = await c.query<{ reviews: { items: Array<{ id: string }> } }>("book", { id: "b2" }, { ...page, policy: "cache" });
      const b1After = await c.query<{ reviews: { items: Array<{ id: string }> } }>("book", { id: "b1" }, { ...page, policy: "cache" });
      expect(b2After.reviews.items).toEqual([]);
      expect(b1After.reviews.items.map((r) => r.id)).toEqual(["r1", "r4"]); // guard: the delete is not blanket
      expect(c.cache.has("Review:r2")).toBe(false);
      // the containing entity survives, minus the reference
    expect(c.cache.denormalize(c.cache.get("Book:b2"))).toEqual({ $type: "Book", id: "b2", title: "Invisible Cities", reviews: { items: [] } });
      expect(notified.some((keys) => keys.includes("Book:b2") && keys.includes("Review:r2")), JSON.stringify(notified)).toBe(true); // watchers of the page are told
      expect(notified.flat()).not.toContain("Book:b1"); // guard: the page that never listed r2 is not
      expect(store.store.calls["Query.book"]).toBe(2); // both reads after the delete came from the cache
    });
  }
});

describe("conditional commands in the client", () => {
  const author = { id: "u1", role: "customer" };
  const shape = "{ id rating body version }";
  const mine = { id: "r2", input: { rating: 3, body: "Mine." } };

  for (const compact of [false, true]) {
    it(`sends ifVersion and merges the server's current entity on a conflict (compact: ${compact})`, async () => {
      const store = createBookstore();
      const sent: RequestOp[] = [];
      const local = createLocalTransport(store.server, () => author);
      const c = new RayfoldClient({ transport: { send: (env, o) => (sent.push(...env.ops), local.send(env, o)) }, ...(compact ? { schema: store.server.ir } : {}) });
      const seen = await c.query<{ version: number }>("review", { id: "r2" }, { shape });
      expect(seen.version).toBe(1);
      // another writer edits r2 behind this client's back
      store.store.reviews.set("r2", { ...store.store.reviews.get("r2")!, rating: 1, body: "Changed elsewhere.", version: 2 });

      const err = await c.command("editReview", mine, { ifVersion: seen.version, shape }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RayfoldClientError);
      expect(err).toMatchObject({ code: "failed_precondition", type: "VersionConflict", data: { key: "Review:r2", expected: 1, actual: 2 } });
      expect(sent.at(-1)).toMatchObject({ op: "editReview", ifVersion: 1 });
      expect(store.store.reviews.get("r2")).toMatchObject({ rating: 1, version: 2 }); // the stale write did not land
      expect(c.cache.get("Review:r2")).toMatchObject({ $type: "Review", rating: 1, body: "Changed elsewhere.", version: 2 });
      const cached = await c.query<{ version: number; rating: number }>("review", { id: "r2" }, { shape, policy: "cache" });
      expect(cached).toMatchObject({ version: 2, rating: 1 });
      expect(store.store.calls["Query.review"]).toBe(1); // the conflict refreshed the cache; no refetch needed

      // guard: the conflict is specific to a stale version; the retry with the fresh one succeeds
      const saved = await c.command<{ version: number; rating: number }>("editReview", mine, { ifVersion: 2, shape });
      expect(saved).toMatchObject({ version: 3, rating: 3 });
      expect(c.cache.get("Review:r2")).toMatchObject({ version: 3, rating: 3 });
    });
  }
});

describe("RB carries what JSON carries", () => {
  it("a non-finite number arrives as null and a Date as its ISO string, over RB as over JSON; guard: a plain double stays one", async () => {
    const SCHEMA = `
entity Stat { id: ID score: Float ratio: Float at: String }
query stat: Stat
`;
    const server = createRayfoldServer({ schema: SCHEMA, resolvers: { Query: { stat: () => ({ id: "s1", score: Number.NaN, ratio: 2.5, at: new Date(0) }) } } as never });
    const http = await listen(server, 0, {});
    try {
      const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/rayfold`;
      const manifest = (await (await fetch(url + "/manifest")).json()) as { schema: RayfoldSchemaIR; schemaHash: string };
      const kinds: string[] = [];
      const recording: typeof fetch = async (input, init) => {
        const res = await fetch(input, init);
        kinds.push(res.headers.get("content-type") ?? "");
        return res;
      };
      const rb = new RayfoldClient({ transport: createFetchTransport({ url, binary: manifest, fetch: recording }) });
      const json = new RayfoldClient({ transport: createFetchTransport({ url }) });
      const shape = { shape: "{ id score ratio at }" };
      const expected = { $type: "Stat", id: "s1", score: null, ratio: 2.5, at: "1970-01-01T00:00:00.000Z" };
      expect(await json.query("stat", {}, shape)).toEqual(expected);
      await rb.query("stat", {}, shape); // learns the server's schema hash
      expect(await rb.query("stat", {}, shape)).toEqual(expected);
      expect(kinds.at(-1)).toBe("application/rayfold");
    } finally {
      await new Promise<void>((r) => {
        http.close(() => r());
        http.closeAllConnections();
      });
    }
  });
});

describe("a schema-aware client and union members that are objects", () => {
  const SCHEMA = `
entity Person { id: ID name: String }
entity Cat { id: ID name: String owner: Person? }
object Photo { url: String }
union Hit = Cat | Photo
query hits: [Hit]
query cover: Photo
`;
  const server = createRayfoldServer({
    schema: SCHEMA,
    resolvers: { Query: { hits: () => [{ $type: "Cat", id: "c1", name: "Tom", owner: { id: "p1", name: "Ann" } }, { $type: "Photo", url: "p.png" }], cover: () => ({ url: "c.png" }) } } as never,
  });
  const shape = "{ ... on Cat { id name } ... on Photo { url } }";

  it("keeps the $type the server sent on an object member, so members stay told apart; as without a schema", async () => {
    const sent: RequestOp[] = [];
    const local = createLocalTransport(server);
    const typed = new RayfoldClient({ transport: { send: (env, o) => (sent.push(...env.ops), local.send(env, o)) }, schema: loadSchema(SCHEMA).ir });
    const plain = new RayfoldClient({ transport: local });
    const expected = [{ $type: "Cat", id: "c1", name: "Tom" }, { $type: "Photo", url: "p.png" }];
    expect(await typed.query("hits", {}, { shape })).toEqual(expected);
    expect(sent[0]).toMatchObject({ op: "hits", compact: true });
    expect(await plain.query("hits", {}, { shape })).toEqual(expected);
  });

  it("restores the types inside a union member by the member's own fields", async () => {
    const typed = new RayfoldClient({ transport: createLocalTransport(server), schema: loadSchema(SCHEMA).ir });
    expect(await typed.query("hits", {}, { shape: "{ ... on Cat { id owner { id name } } ... on Photo { url } }" })).toEqual([{ $type: "Cat", id: "c1", owner: { $type: "Person", id: "p1", name: "Ann" } }, { $type: "Photo", url: "p.png" }]);
    expect(typed.cache.get("Person:p1")).toEqual({ $type: "Person", id: "p1", name: "Ann" });
  });

  it("guard: an object outside a union gains no $type", async () => {
    const typed = new RayfoldClient({ transport: createLocalTransport(server), schema: loadSchema(SCHEMA).ir });
    expect(await typed.query("cover", {}, { shape: "{ url }" })).toEqual({ url: "c.png" });
  });
});

describe("RayfoldClientError through the client", () => {
  const failing = (error: Record<string, unknown>): Transport => ({
    send: async function* () {
      yield { id: 1, error, fin: true } as Frame;
    },
  });
  const failure = (error: Record<string, unknown>) => new RayfoldClient({ transport: failing(error) }).query("book", { id: "b1" }).then(() => { throw new Error("no failure"); }, (e: unknown) => e as RayfoldClientError);

  it("is() narrows on a declared domain error only; guard: the same type under another code is not one", async () => {
    const domain = await failure({ code: "domain", type: "OutOfStock", message: "Sold out", data: { available: 0 } });
    expect([domain.is("OutOfStock"), domain.is("Other"), domain.data]).toEqual([true, false, { available: 0 }]);
    // a protocol error carries a type too, and is not a declared error of the application
    const conflict = await failure({ code: "failed_precondition", type: "OutOfStock", message: "Stale" });
    expect(conflict.is("OutOfStock")).toBe(false);
  });

  it("retryable follows the code unless the server says otherwise", async () => {
    const codes = ["unavailable", "deadline_exceeded", "aborted", "invalid_argument", "domain", "permission_denied"];
    const byCode = await Promise.all(codes.map(async (code) => [code, (await failure({ code, message: code })).retryable]));
    expect(byCode).toEqual([
      ["unavailable", true],
      ["deadline_exceeded", true],
      ["aborted", true],
      ["invalid_argument", false],
      ["domain", false],
      ["permission_denied", false],
    ]);
    // the server's own word wins either way
    expect([(await failure({ code: "unavailable", message: "x", retryable: false })).retryable, (await failure({ code: "domain", message: "x", retryable: true })).retryable]).toEqual([false, true]);
  });
});

describe("policy: cache serves a fresh result only", () => {
  const shape = { shape: "{ id stock }" };
  it("an entity the result holds marked stale, or the op invalidated, sends the query again; guard: a fresh one is served from the cache", async () => {
    await client.query("book", { id: "b1" }, shape);
    expect(await client.query("book", { id: "b1" }, { ...shape, policy: "cache" })).toEqual({ $type: "Book", id: "b1", stock: 5 });
    expect(bs.store.calls["Query.book"]).toBe(1);

    client.cache.applyPatch([{ inv: ["Book:b1"] }]);
    expect(await client.query("book", { id: "b1" }, { ...shape, policy: "cache" })).toEqual({ $type: "Book", id: "b1", stock: 5 });
    expect(bs.store.calls["Query.book"]).toBe(2);
    expect(await client.query("book", { id: "b1" }, { ...shape, policy: "cache" })).toEqual({ $type: "Book", id: "b1", stock: 5 });
    expect(bs.store.calls["Query.book"]).toBe(2); // the refetch made it fresh again

    client.cache.applyPatch([{ invOp: ["book"] }]);
    await client.query("book", { id: "b1" }, { ...shape, policy: "cache" });
    expect(bs.store.calls["Query.book"]).toBe(3);
  });
});

describe("stream endings", () => {
  const drain = async (items: AsyncIterable<unknown>) => {
    const got: unknown[] = [];
    try {
      for await (const x of items) got.push(x);
    } catch (e) {
      return { got, error: (e as RayfoldClientError).code };
    }
    return { got, error: null };
  };

  it("an item frame that carries fin is the last one; guard: frames after it are not read", async () => {
    let read = 0;
    const last: Transport = {
      send: async function* () {
        read++;
        yield { id: 1, item: 1 } as Frame;
        read++;
        yield { id: 1, item: 2, fin: true } as Frame;
        read++;
        yield { id: 1, item: 3 } as Frame;
      },
    };
    expect(await drain(new RayfoldClient({ transport: last }).stream("ticks"))).toEqual({ got: [1, 2], error: null });
    expect(read).toBe(2);
  });

  it("a transport that answers the caller's abort by just ending ends the stream quietly; guard: unasked, that ending is a failure", async () => {
    const quiet: Transport = {
      send: (_env, o) =>
        (async function* () {
          yield { id: 1, item: 1 } as Frame;
          await new Promise<void>((r) => (o?.signal?.aborted ? r() : o?.signal?.addEventListener("abort", () => r(), { once: true })));
        })(),
    };
    const ac = new AbortController();
    const got: unknown[] = [];
    const reading = (async () => {
      for await (const x of new RayfoldClient({ transport: quiet }).stream("ticks", {}, { signal: ac.signal })) {
        got.push(x);
        ac.abort();
      }
      return "ended";
    })();
    expect(await bounded(reading, "the aborted stream")).toBe("ended");
    expect(got).toEqual([1]);
  });
});

describe("watch of a result that holds no entity", () => {
  it("a refetch that changed the result calls back, though no entity key changed", async () => {
    let count = 0;
    const counter: Transport = {
      send: async function* () {
        yield { id: 1, data: { count: ++count }, fin: true } as Frame;
      },
    };
    const c = new RayfoldClient({ transport: counter });
    const seen = new Signal<unknown>();
    const stop = c.watch("stats", {}, {}, (d) => seen.push(d));
    await seen.atLeast(1, "the first count");
    await c.query("stats", {});
    await seen.atLeast(2, "the refetched count");
    expect(seen.items).toEqual([{ count: 1 }, { count: 2 }]);
    stop();
  });
});

describe("what the cache takes for an entity, a ref and a result", () => {
  /** A transport answering every op with `answer(op)` and counting what it was sent. */
  const answering = (answer: (op: RequestOp) => Frame[]) => {
    const sent: RequestOp[] = [];
    const transport: Transport = {
      send: async function* (env) {
        for (const op of env.ops) {
          sent.push(op);
          yield* answer(op);
        }
      },
    };
    return { sent, transport };
  };

  it("an entity with a numeric id is normalized like one with a string id", async () => {
    const { transport } = answering(() => [{ id: 1, data: { $type: "Item", id: 7, name: "seven" }, fin: true } as Frame]);
    const c = new RayfoldClient({ transport });
    await c.query("item", {});
    expect(c.cache.get("Item:7")).toEqual({ $type: "Item", id: 7, name: "seven" });
    c.cache.applyPatch([{ set: "Item:7", value: { name: "SEVEN" } }]);
    expect(await c.query("item", {}, { policy: "cache" })).toEqual({ $type: "Item", id: 7, name: "SEVEN" });
  });

  it("an object of the application's that has a $ref field among others is data, not a cache ref", async () => {
    const doc = { schema: { $ref: "#/definitions/x", title: "T" } };
    const { transport } = answering(() => [{ id: 1, data: doc, fin: true } as Frame]);
    expect(await new RayfoldClient({ transport }).query("doc", {})).toEqual(doc);
  });

  it("results are told apart by their variables, and arguments match whatever order their keys came in", async () => {
    const { sent, transport } = answering((op) => [{ id: 1, data: { v: (op.vars as { x?: number } | undefined)?.x ?? null, args: op.args }, fin: true } as Frame]);
    const c = new RayfoldClient({ transport });
    await c.query("echo", { a: 1, b: 2 }, { shape: "{ v args }", vars: { x: 1 } });
    await c.query("echo", { a: 1, b: 2 }, { shape: "{ v args }", vars: { x: 2 } });
    expect(await c.query("echo", { b: 2, a: 1 }, { shape: "{ v args }", vars: { x: 1 }, policy: "cache" })).toEqual({ v: 1, args: { a: 1, b: 2 } });
    expect(await c.query("echo", { b: 2, a: 1 }, { shape: "{ v args }", vars: { x: 2 }, policy: "cache" })).toEqual({ v: 2, args: { a: 1, b: 2 } });
    expect(sent).toHaveLength(2);
    // guard: other argument values are another result
    await c.query("echo", { a: 1, b: 3 }, { shape: "{ v args }", vars: { x: 1 }, policy: "cache" });
    expect(sent).toHaveLength(3);
  });

  it("an entity a deferred part brought in is part of the result: a later change to it reaches the watch", async () => {
    const { transport } = answering(() => [
      { id: 1, data: { $type: "Author", id: "a1", name: "A" } } as Frame,
      { id: 1, at: "", data: { best: { $type: "Book", id: "b9", title: "X" } } } as Frame,
      { id: 1, fin: true } as Frame,
    ]);
    const c = new RayfoldClient({ transport });
    const seen = new Signal<unknown>();
    const stop = c.watch("author", {}, { shape: "{ id name @defer { best { id title } } }" }, (d) => seen.push(d));
    await seen.atLeast(1, "the author with its deferred part");
    c.cache.applyPatch([{ set: "Book:b9", value: { title: "Y" } }]);
    await seen.atLeast(2, "the change to the deferred book");
    expect(seen.items).toEqual([
      { $type: "Author", id: "a1", name: "A", best: { $type: "Book", id: "b9", title: "X" } },
      { $type: "Author", id: "a1", name: "A", best: { $type: "Book", id: "b9", title: "Y" } },
    ]);
    stop();
  });

  it("a self-referencing entity reads back cut at the depth asked for, not without end", () => {
    const c = new RayfoldCache(() => 0);
    c.applyPatch([{ set: "Node:n1", value: { name: "loop", next: { $ref: "Node:n1" } } }]);
    expect(c.denormalize({ $ref: "Node:n1" }, 2)).toEqual({ $type: "Node", id: "n1", name: "loop", next: { $type: "Node", id: "n1", name: "loop", next: { $type: "Node", id: "n1" } } });
  });
});

describe("live patches onto one stored result", () => {
  /** Answers the live op with `frames`, then holds it open until the caller aborts, as a server does. */
  const live = (frames: Frame[], gate?: Promise<void>, after: Frame[] = []): Transport => ({
    send: (env, o) =>
      (async function* () {
        if (env.ops[0]!.live !== true) {
          yield { ...(frames[0] as object), fin: true } as Frame;
          return;
        }
        yield* frames;
        if (gate) {
          await gate;
          yield* after;
        }
        await new Promise<void>((r) => (o?.signal?.aborted ? r() : o?.signal?.addEventListener("abort", () => r(), { once: true })));
      })(),
  });
  const follow = <T>(c: RayfoldClient, op: string, shape: string) => collect<T>((next, fail) => c.live<T>(op, {}, { shape }, next, fail));

  it("a list patch removing several positions removes exactly those, whatever order it names them in", async () => {
    const row = (id: string) => ({ $type: "Book", id });
    const c = new RayfoldClient({ transport: live([{ id: 1, data: { items: ["a", "b", "c", "d"].map(row) } } as Frame, { id: 1, patch: [{ list: "items", del: [0, 2] }] } as Frame]) });
    const seen = follow<{ items: Array<{ id: string }> }>(c, "books", "{ items { id } }");
    expect((await seen.next("the list")).items.map((b) => b.id)).toEqual(["a", "b", "c", "d"]);
    expect((await seen.next("the removal")).items.map((b) => b.id)).toEqual(["b", "d"]);
    seen.stop();
  });

  it("a patch at a path through an aliased field reaches the entity under the alias", async () => {
    const c = new RayfoldClient({
      transport: live([
        { id: 1, data: { $type: "Book", id: "b1", by: { $type: "User", id: "u1", name: "N" } } } as Frame,
        { id: 1, patch: [{ at: "by", value: { name: "M" } }] } as Frame,
      ]),
    });
    const seen = follow<unknown>(c, "book", "{ id by: author { id name } }");
    expect(await seen.next("the book")).toEqual({ $type: "Book", id: "b1", by: { $type: "User", id: "u1", name: "N" } });
    expect(await seen.next("the patch")).toEqual({ $type: "Book", id: "b1", by: { $type: "User", id: "u1", name: "M" } });
    expect(c.cache.get("User:u1")).toEqual({ $type: "User", id: "u1", name: "M" });
    seen.stop();
  });

  it("a patch at a list element keeps an aliased field with the result; guard: a plain field reaches the entity", async () => {
    const c = new RayfoldClient({
      transport: live([
        { id: 1, data: { items: [{ $type: "Book", id: "b1", x: "T", stock: 1 }] } } as Frame,
        { id: 1, patch: [{ at: "items.0", value: { x: "T2", stock: 2 } }] } as Frame,
      ]),
    });
    const seen = follow<unknown>(c, "books", "{ items { id x: title stock } }");
    await seen.next("the list");
    expect(await seen.next("the patch")).toEqual({ items: [{ $type: "Book", id: "b1", x: "T2", stock: 2 }] });
    expect(c.cache.get("Book:b1")).toEqual({ $type: "Book", id: "b1", stock: 2 });
    seen.stop();
  });

  it("a watch of the same result hears a deferred part the live query receives later, though the result holds no entity", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const c = new RayfoldClient({ transport: live([{ id: 1, data: { count: 1 } } as Frame], gate, [{ id: 1, at: "", data: { extra: 5 } } as Frame, { id: 1, patch: [{ at: "", value: { count: 2 } }] } as Frame]) });
    const following = follow<unknown>(c, "stats", "{ count extra }");
    expect(await following.next("the live result")).toEqual({ count: 1 });
    const watched = collect<unknown>((next, fail) => c.watch("stats", {}, { shape: "{ count extra }" }, next, fail));
    expect(await watched.next("the watched result")).toEqual({ count: 1 });
    release();
    expect(await watched.next("the deferred part")).toEqual({ count: 1, extra: 5 });
    expect(await watched.next("the patch at the root")).toEqual({ count: 2, extra: 5 });
    watched.stop();
    following.stop();
  });

  it("deleting an entity held only under an alias inside another entity's list leaves null there, not a dangling ref", () => {
    const c = new RayfoldCache(() => 0);
    const shape = parseShapeText("{ id reviews { id by: author { id name } } }");
    c.putResult("k", "book", { $type: "Book", id: "b1", reviews: [{ $type: "Review", id: "r1", by: { $type: "User", id: "u1", name: "N" } }] }, shape);
    c.applyPatch([{ del: "User:u1" }]);
    expect(c.denormalize(c.getResult("k")!.data)).toEqual({ $type: "Book", id: "b1", reviews: [{ $type: "Review", id: "r1", by: null }] });
  });
});

describe("cache notifications", () => {
  it("a command's result and its patch reach a listener as one notification; nested transactions coalesce into the outer one", async () => {
    viewer = { id: "u9", role: "admin" };
    await client.query("book", { id: "b1" }, { shape: "{ id stock }" });
    const events: Array<{ keys: string[]; ops: string[] }> = [];
    const off = client.cache.subscribe((e) => events.push({ keys: [...e.keys].sort(), ops: [...e.ops].sort() }));
    await client.command("restock", { bookId: "b1", qty: 1 }, { shape: "{ id stock }" });
    expect(events).toHaveLength(1);
    events.length = 0;
    client.cache.transaction(() => {
      client.cache.applyPatch([{ set: "Book:b1", value: { stock: 1 } }]);
      client.cache.transaction(() => client.cache.applyPatch([{ set: "Book:b2", value: { stock: 2 } }]));
      client.cache.applyPatch([{ inv: ["Book:b3"] }]);
    });
    expect(events).toEqual([{ keys: ["Book:b1", "Book:b2", "Book:b3"], ops: ["book"] }]);
    // guard: an unsubscribed listener hears nothing more
    off();
    client.cache.applyPatch([{ set: "Book:b1", value: { stock: 3 } }]);
    expect(events).toHaveLength(1);
  });

  it("clear() forgets entities, results, staleness and predictions", () => {
    const c = new RayfoldCache(() => 0);
    c.putResult("k", "book", { $type: "Book", id: "b1", stock: 1 });
    c.applyPatch([{ inv: ["Book:b1"] }]);
    c.addLayer("p", [{ set: "Book:b2", value: { stock: 9 } }]);
    c.clear();
    expect([c.size, c.getResult("k"), c.isStale("Book:b1"), c.predictions, c.get("Book:b2")]).toEqual([0, undefined, false, [], undefined]);
  });
});

describe("a schema-aware client and a deferred part", () => {
  const SCHEMA = `
entity Book { id: ID title: String }
entity Shelf { id: ID name: String featured: Book @lazy }
query shelf: Shelf
query shelves: [Shelf]
`;
  it("restores the types of what a deferred part carries, so its entities are normalized; guard: as without a schema", async () => {
    const server = createRayfoldServer({ schema: SCHEMA, resolvers: { Query: { shelf: () => ({ id: "s1", name: "N", featured: { id: "b1", title: "T" } }) } } as never });
    const frames: Frame[] = [];
    const local = createLocalTransport(server);
    const tap: Transport = {
      send: (env, o) =>
        (async function* () {
          for await (const f of local.send(env, o)) yield (frames.push(f), f);
        })(),
    };
    const expected = { $type: "Shelf", id: "s1", name: "N", featured: { $type: "Book", id: "b1", title: "T" } };
    const typed = new RayfoldClient({ transport: tap, schema: loadSchema(SCHEMA).ir });
    expect(await typed.query("shelf", {}, { shape: "{ id name featured { id title } }" })).toEqual(expected);
    expect(frames.find((f) => "at" in f)).toEqual({ id: 1, at: "", data: { featured: { id: "b1", title: "T" } } });
    expect(typed.cache.get("Book:b1")).toEqual({ $type: "Book", id: "b1", title: "T" });
    const plain = new RayfoldClient({ transport: local });
    expect(await plain.query("shelf", {}, { shape: "{ id name featured { id title } }" })).toEqual(expected);
  });

  it("restores the types of a deferred part under an alias", async () => {
    const ALIASED = `
entity Book { id: ID title: String }
entity Shelf { id: ID name: String featured: Book @lazy }
entity Room { id: ID shelf: Shelf }
query room: Room
`;
    const server = createRayfoldServer({ schema: ALIASED, resolvers: { Query: { room: () => ({ id: "r1", shelf: { id: "s1", name: "N", featured: { id: "b1", title: "T" } } }) } } as never });
    const frames: Frame[] = [];
    const local = createLocalTransport(server);
    const tap: Transport = {
      send: (env, o) =>
        (async function* () {
          for await (const f of local.send(env, o)) yield (frames.push(f), f);
        })(),
    };
    const typed = new RayfoldClient({ transport: tap, schema: loadSchema(ALIASED).ir });
    const expected = { $type: "Room", id: "r1", mine: { $type: "Shelf", id: "s1", name: "N", featured: { $type: "Book", id: "b1", title: "T" } } };
    expect(await typed.query("room", {}, { shape: "{ id mine: shelf { id name featured { id title } } }" })).toEqual(expected);
    expect(frames.find((f) => "at" in f)).toEqual({ id: 1, at: "mine", data: { featured: { id: "b1", title: "T" } } });
    expect(typed.cache.get("Book:b1")).toEqual({ $type: "Book", id: "b1", title: "T" });
    expect(typed.cache.get("Shelf:s1")).toEqual({ $type: "Shelf", id: "s1", name: "N", featured: { $ref: "Book:b1", $sel: { $type: true, id: true, title: true } } });
    // guard: as without a schema
    expect(await new RayfoldClient({ transport: local }).query("room", {}, { shape: "{ id mine: shelf { id name featured { id title } } }" })).toEqual(expected);
  });

  it("reads an alias inside a view, a deferred block and a member's fragment as the field it names", async () => {
    const ALIASED = `
entity Shelf { id: ID name: String }
entity Room { id: ID shelf: Shelf }
object Photo { url: String }
union Thing = Room | Photo
query room: Room
query things: [Thing]
view Room.card = { id mine: shelf { id name } }
`;
    const room = { id: "r1", shelf: { id: "s1", name: "N" } };
    const server = createRayfoldServer({ schema: ALIASED, resolvers: { Query: { room: () => room, things: () => [{ $type: "Room", ...room }, { $type: "Photo", url: "p.png" }] } } as never });
    const typed = new RayfoldClient({ transport: createLocalTransport(server), schema: loadSchema(ALIASED).ir });
    const mine = { $type: "Shelf", id: "s1", name: "N" };
    expect(await typed.query("room", {}, { shape: "{ ...Room.card }" })).toEqual({ $type: "Room", id: "r1", mine });
    expect(await typed.query("room", {}, { shape: "{ id @defer { mine: shelf { id name } } }" })).toEqual({ $type: "Room", id: "r1", mine });
    expect(await typed.query("things", {}, { shape: "{ ... on Room { id mine: shelf { id name } } ... on Photo { url } }" })).toEqual([{ $type: "Room", id: "r1", mine }, { $type: "Photo", url: "p.png" }]);
    expect(typed.cache.get("Shelf:s1")).toEqual(mine);
  });

  it("reads aliases at every depth, in deferred parts, member fragments, interfaces, commands, dry runs and streams", async () => {
    const DEEP = `
object Named @interface { id: ID name: String }
object Holder @interface { id: ID shelf: Shelf }
entity Book implements Named { id: ID name: String }
entity Box { id: ID featured: Book @lazy }
entity Shelf { id: ID box: Box }
entity Room implements Holder { id: ID shelf: Shelf }
object Photo { url: String }
union Thing = Room | Photo
query holder: Holder
query room: Room
query rooms: [Room]
query things: [Thing]
query named: Named
command move(id: ID): Room @simulate
stream moves: Room
`;
    const room = { id: "r1", shelf: { id: "s1", box: { id: "x1", featured: { id: "b1", name: "T" } } } };
    const server = createRayfoldServer({
      schema: DEEP,
      resolvers: {
        Query: { holder: () => ({ $type: "Room", ...room }), room: () => room, rooms: () => [room], things: () => [{ $type: "Photo", url: "p.png" }, { $type: "Room", ...room }], named: () => ({ $type: "Book", id: "b1", name: "T" }) },
        Command: { move: () => ok(room) },
        Stream: { moves: () => (async function* () { yield room; })() },
      },
    } as never);
    const c = new RayfoldClient({ transport: createLocalTransport(server, () => ({ id: "u1" })), schema: loadSchema(DEEP).ir });
    const shape = "{ id mine: shelf { id b: box { id fav: featured { id name } } } }";
    const fav = { $type: "Book", id: "b1", name: "T" };
    const typed = { $type: "Room", id: "r1", mine: { $type: "Shelf", id: "s1", b: { $type: "Box", id: "x1", fav } } };
    // the deferred `fav` comes at the path "mine.b", or "0.mine.b" in a list
    expect(await c.query("room", {}, { shape })).toEqual(typed);
    expect(await c.query("rooms", {}, { shape })).toEqual([typed]);
    expect(await c.command("move", { id: "r1" }, { shape })).toEqual(typed);
    expect(await c.command("move", { id: "r1" }, { shape, simulate: true })).toEqual(typed);
    // the member fragment that comes first is another member's, under the same alias
    expect(await c.query("things", {}, { shape: `{ ... on Photo { x: url } ... on Room { id x: shelf { id } } }` })).toEqual([{ $type: "Photo", x: "p.png" }, { $type: "Room", id: "r1", x: { $type: "Shelf", id: "s1" } }]);
    expect(await c.query("named", {}, { shape: "{ ... on Named { id n: name } }" })).toEqual({ $type: "Book", id: "b1", n: "T" });
    // a fragment on an interface the member implements applies to the member
    expect(await c.query("holder", {}, { shape: "{ ... on Holder { id s: shelf { id } } }" })).toEqual({ $type: "Room", id: "r1", s: { $type: "Shelf", id: "s1" } });
    const items: unknown[] = [];
    for await (const m of c.stream("moves", {}, { shape })) items.push(m);
    expect(items).toEqual([typed]);
    expect(c.cache.get("Book:b1")).toEqual({ $type: "Book", id: "b1", name: "T" });
  });

  it("restores the types of a deferred part inside a list element", async () => {
    const server = createRayfoldServer({ schema: SCHEMA, resolvers: { Query: { shelves: () => [{ id: "s1", name: "N", featured: { id: "b1", title: "T" } }] } } as never });
    const frames: Frame[] = [];
    const local = createLocalTransport(server);
    const tap: Transport = {
      send: (env, o) =>
        (async function* () {
          for await (const f of local.send(env, o)) yield (frames.push(f), f);
        })(),
    };
    const typed = new RayfoldClient({ transport: tap, schema: loadSchema(SCHEMA).ir });
    expect(await typed.query("shelves", {}, { shape: "{ id name featured { id title } }" })).toEqual([{ $type: "Shelf", id: "s1", name: "N", featured: { $type: "Book", id: "b1", title: "T" } }]);
    expect(frames.find((f) => "at" in f)).toEqual({ id: 1, at: "0", data: { featured: { id: "b1", title: "T" } } });
    expect(typed.cache.get("Book:b1")).toEqual({ $type: "Book", id: "b1", title: "T" });
  });
});

describe("typeAtPath, as exported", () => {
  const ir = loadSchema(`
entity Book { id: ID title: String author: Author }
entity Author { id: ID name: String }
query books: [Book]
`).ir;
  const root = ir.ops["books"]!.returns;
  it("follows output names through lists and aliases, and knows no field it cannot find", () => {
    const at = (path: string, shape?: string) => typeAtPath(ir, root, path, shape === undefined ? undefined : parseShapeText(shape));
    expect(at("")).toEqual(root);
    expect(at("0")).toEqual({ kind: "named", name: "Book", nullable: false });
    expect(at("0.author")).toEqual({ kind: "named", name: "Author", nullable: false });
    expect(at("author")).toEqual({ kind: "named", name: "Author", nullable: false }); // a list level without its index
    expect(at("0.writer", "{ id writer: author { id } }")).toEqual({ kind: "named", name: "Author", nullable: false });
    expect([at("0.writer"), at("0.nope")]).toEqual([undefined, undefined]);
  });
});
