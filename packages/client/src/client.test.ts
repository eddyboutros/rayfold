import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { RbCodec } from "@rayfold/rb";
import { loadSchema, schemaHash, type RayfoldSchemaIR } from "@rayfold/schema";
import { listen, type Frame, type RequestEnvelope, type RequestOp } from "@rayfold/server";
import { Signal, bounded } from "../../../e2e/wait.ts";
import { parseShapeText } from "@rayfold/schema";
import { bookstoreSchemaText, createBookstore } from "../../../examples/bookstore-ts/src/index.ts";
import { RayfoldCache } from "./cache.ts";
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
    expect(c.get("Book:b1")).toMatchObject({ $type: "Book", id: "b1", title: "T", author: { $ref: "Author:a1" } });
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
    expect(await client.query<{ reviews: { items: unknown[] } }>("book", { id: "b1" }, { shape: "{ id reviews(page: { first: 1 }) { items { id } } }", policy: "cache" })).toMatchObject({ reviews: { items: [{ id: "r1" }] } });

    const named = await client.query<{ x: unknown }>("book", { id: "b1" }, { shape: "{ id x: title }" });
    const counted = await client.query<{ x: unknown }>("book", { id: "b1" }, { shape: "{ id x: stock }" });
    expect([named.x, counted.x]).toEqual(["The Dispossessed", 5]);
    expect(await client.query<{ x: unknown }>("book", { id: "b1" }, { shape: "{ id x: title }", policy: "cache" })).toMatchObject({ x: "The Dispossessed" });
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
    expect(dry).toMatchObject({ $type: "Book", id: "b1", stock: 105 }); // what the restock would leave
    expect(watched.items).toEqual([5]); // written to the cache, it showed 105 as if it had happened
    expect(await client.query<{ stock: number }>("book", { id: "b1" }, { shape: "{ id stock }", policy: "cache" })).toMatchObject({ stock: 5 });
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
    expect(deferred.bio).toContain("speculative");
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
    expect(author).toMatchObject({ $type: "Author", bio: expect.stringContaining("speculative") });
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
    expect(await c.query<{ id: string }>("book", { id: "b2" }, { shape: "{ id }" })).toMatchObject({ id: "b2" }); // guard: a plain query is still safe
    expect(sent).toEqual([null, "true"]);
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
      expect(notified.flat()).toContain("Book:b2"); // watchers of the page are told
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
