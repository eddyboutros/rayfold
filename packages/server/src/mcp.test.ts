import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createBookstore } from "../../../examples/bookstore-ts/src/index.ts";
import { createMcpHandler, handleMcp, mcpResources, mcpTools } from "./mcp.ts";
import { createRayfoldServer, type RayfoldServer } from "./server.ts";
import { MemoryIdempotencyStore } from "./context.ts";

type Bookstore = ReturnType<typeof createBookstore>;
type Reply = { result: Record<string, unknown> };
let bs: Bookstore;
beforeEach(() => {
  bs = createBookstore();
});

const u1 = { id: "u1", role: "customer" };
const SCHEMA_2020 = "https://json-schema.org/draft/2020-12/schema";
const call = (name: string, args: Record<string, unknown>, viewer: unknown = null, id = 1, server: RayfoldServer = bs.server) =>
  handleMcp(server, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, viewer);
const order = (bookId: string, qty: number) => ({ input: { lines: [{ bookId, qty }] } });

describe("MCP tools and resources", () => {
  it("exposes commands and queries as tools with JSON Schema 2020-12 in/out schemas, @range bounds included", () => {
    const tools = mcpTools(bs.server);
    const names = tools.map((t) => t.name);
    expect(names).toContain("placeOrder");
    expect(names).toContain("placeOrder.simulate");
    expect(names).toContain("books");
    expect(names).not.toContain("stockUpdates");
    const place = tools.find((t) => t.name === "placeOrder")!;
    expect(place.inputSchema).toEqual({
      $schema: SCHEMA_2020,
      type: "object",
      properties: { input: { $ref: "#/$defs/OrderInput" } },
      additionalProperties: false,
      required: ["input"],
      $defs: {
        OrderInput: { type: "object", properties: { lines: { type: "array", items: { $ref: "#/$defs/OrderLine" } } }, additionalProperties: false, required: ["lines"] },
        OrderLine: {
          type: "object",
          properties: { bookId: { type: "string" }, qty: { type: "integer", minimum: 1, maximum: 100, "x-rayfold-range": { min: 1, max: 100 } } },
          additionalProperties: false,
          required: ["bookId"], // qty has a default
        },
      },
    });
    const review = tools.find((t) => t.name === "addReview")!;
    expect((review.inputSchema as { $defs: Record<string, unknown> }).$defs["ReviewInput"]).toEqual({
      type: "object",
      properties: {
        bookId: { type: "string" },
        rating: { type: "integer", minimum: 1, maximum: 5, "x-rayfold-range": { min: 1, max: 5 } },
        body: { type: "string", minLength: 1, maxLength: 2000, "x-rayfold-range": { min: 1, max: 2000 } },
      },
      additionalProperties: false,
      required: ["bookId", "rating", "body"],
    });
    expect(place.description).toContain("OutOfStock");
    expect(place.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    expect((place.outputSchema as { $schema: string; $defs: Record<string, unknown> }).$schema).toBe(SCHEMA_2020);
    expect((place.outputSchema as { $defs: Record<string, unknown> }).$defs).toHaveProperty("Order");
    const books = tools.find((t) => t.name === "books")!;
    expect(books.annotations).toEqual({ readOnlyHint: true, idempotentHint: true });
    expect((books.outputSchema as { $defs: Record<string, unknown> }).$defs).toHaveProperty("Page_Book");
  });

  it("top-level @range arguments become JSON Schema bounds, and the pipeline enforces the same bounds", async () => {
    const s = createRayfoldServer({
      schema: `entity A { id: ID } command set(qty: Int @range(min: 1, max: 5), name: String @range(min: 2, max: 3), price: Decimal @range(min: 0), free: Int): A @idempotent(false)`,
      resolvers: { Command: { set: () => ({ id: "a" }) } },
    });
    expect(mcpTools(s).find((t) => t.name === "set")!.inputSchema).toEqual({
      $schema: SCHEMA_2020,
      type: "object",
      properties: {
        qty: { type: "integer", minimum: 1, maximum: 5, "x-rayfold-range": { min: 1, max: 5 } },
        name: { type: "string", minLength: 2, maxLength: 3, "x-rayfold-range": { min: 2, max: 3 } },
        price: { type: "string", pattern: "^-?\\d+(\\.\\d+)?$", "x-rayfold-range": { min: 0 } }, // Decimal travels as text: only the x- keyword can carry the bound
        free: { type: "integer" },
      },
      additionalProperties: false,
      required: ["qty", "name", "price", "free"],
    });
    const errorOf = async (args: Record<string, unknown>) => ((await call("set", args, null, 1, s)) as Reply).result["structuredContent"];
    expect(await errorOf({ qty: 6, name: "ab", price: "1", free: 0 })).toEqual({ error: { code: "invalid_argument", message: "set().qty: must be <= 5" } });
    expect(await errorOf({ qty: 5, name: "abcd", price: "1", free: 0 })).toEqual({ error: { code: "invalid_argument", message: "set().name: must be <= 3" } });
    expect(await errorOf({ qty: 5, name: "abc", price: "-1", free: 0 })).toEqual({ error: { code: "invalid_argument", message: "set().price: must be >= 0" } });
    // guard: the boundary values themselves are accepted
    expect(await errorOf({ qty: 5, name: "ab", price: "0", free: -9 })).toEqual({ result: { $type: "A", id: "a" }, effects: [{ set: "A:a", value: { $type: "A", id: "a" } }] });
  });

  it("lists resources for argument-free queries and the schema", async () => {
    expect(mcpResources(bs.server).map((r) => r.uri)).toEqual(["rayfold://schema", "rayfold://query/books", "rayfold://query/myOrders"]);
    const list = (await handleMcp(bs.server, { jsonrpc: "2.0", id: 1, method: "resources/list" }, null)) as Reply;
    expect(list.result["resources"]).toEqual(mcpResources(bs.server));
  });

  it("tools/list returns the same tools as mcpTools with a cache hint", async () => {
    const list = (await handleMcp(bs.server, { jsonrpc: "2.0", id: 1, method: "tools/list" }, null)) as Reply;
    expect(list.result).toEqual({ tools: mcpTools(bs.server), ttlMs: 300000, cacheScope: "public" });
  });
});

describe("MCP tool calls run through the normal pipeline", () => {
  it("policies: an anonymous caller gets a tool error and nothing is written; a signed-in caller places the order (guard)", async () => {
    expect(await call("placeOrder", order("b1", 1))).toMatchObject({ result: { isError: true, structuredContent: { error: { code: "unauthenticated" } } } });
    expect(bs.store.orders.size).toBe(0);
    expect(await call("placeOrder", order("b1", 1), u1)).toMatchObject({ result: { resultType: "complete", structuredContent: { result: { id: "o1", status: "PLACED" } } } });
    expect(bs.store.orders.size).toBe(1);
  });

  it("simulate returns the would-be result and effects without writing", async () => {
    const sim = await call("placeOrder.simulate", order("b1", 1), u1);
    expect(sim).toMatchObject({ result: { resultType: "complete", structuredContent: { result: { status: "PLACED", total: "12.99" }, effects: expect.arrayContaining([{ set: "Book:b1", value: { stock: 4 } }]) } } });
    expect(bs.store.orders.size).toBe(0);
    expect(bs.store.books.get("b1")!.stock).toBe(5);
  });

  it("typed domain errors keep their type and data", async () => {
    expect(await call("placeOrder", order("b4", 1), u1)).toMatchObject({
      result: { isError: true, content: [{ type: "text", text: expect.stringContaining("OutOfStock") }], structuredContent: { error: { code: "domain", type: "OutOfStock", data: { bookId: "b4", available: 0 } } } },
    });
  });

  it("two commands called with the same arguments are two calls, each keyed by its operation, and a repeat of one replays", async () => {
    // a key made of the arguments alone was the same for both, so the second was refused as a reuse of the first's key
    const runs: string[] = [];
    const store = new MemoryIdempotencyStore();
    const claimed: string[] = [];
    const claim = store.claim.bind(store);
    store.claim = (scope, key, leaseMs) => (claimed.push(key), claim(scope, key, leaseMs));
    const orders = createRayfoldServer({
      schema: `entity Order { id: ID state: String } command cancelOrder(id: ID): Order command refundOrder(id: ID): Order`,
      idempotency: store,
      resolvers: {
        Command: {
          cancelOrder: ({ id }: { id: string }) => (runs.push(`cancel ${id}`), { id, state: "cancelled" }),
          refundOrder: ({ id }: { id: string }) => (runs.push(`refund ${id}`), { id, state: "refunded" }),
        },
      } as never,
    });
    const resultOf = async (name: string) => ((await call(name, { id: "r1" }, u1, 1, orders)) as Reply).result;
    expect(await resultOf("cancelOrder")).toMatchObject({ structuredContent: { result: { state: "cancelled" } } });
    expect(await resultOf("refundOrder")).toMatchObject({ structuredContent: { result: { state: "refunded" } } });
    expect(await resultOf("cancelOrder")).toMatchObject({ structuredContent: { result: { state: "cancelled" } } }); // guard: the same call replays
    expect(runs).toEqual(["cancel r1", "refund r1"]);
    // the key the JVM bridge derives too: mcp- and the SHA-256 of {"args":{"id":"r1"},"op":"cancelOrder"}
    expect(claimed).toEqual([
      "mcp-0e33ac87ef0b7d8778fdb3e71157a86b69fc870673ffb6e45216915a20fd86a0",
      "mcp-a2e471d5d53e28ddd7f6e5176f511dc3612878c5062a0f9cbf225886886b022a",
      "mcp-0e33ac87ef0b7d8778fdb3e71157a86b69fc870673ffb6e45216915a20fd86a0",
    ]);
  });

  it("repeating a call with the same arguments replays the first result; different arguments place a new order (guard)", async () => {
    const first = (await call("placeOrder", order("b3", 2), u1)) as Reply;
    const again = (await call("placeOrder", order("b3", 2), u1, 2)) as Reply;
    expect(first.result["structuredContent"]).toMatchObject({ result: { id: "o1" }, effects: expect.arrayContaining([{ set: "Book:b3", value: { stock: 98 } }]) });
    expect(again.result).toEqual(first.result);
    expect(bs.store.orders.size).toBe(1);
    expect(bs.store.calls["Command.placeOrder"]).toBe(1);
    expect(bs.store.books.get("b3")!.stock).toBe(98);
    expect(await call("placeOrder", order("b3", 1), u1, 3)).toMatchObject({ result: { structuredContent: { result: { id: "o2" } } } });
    expect(bs.store.orders.size).toBe(2);
  });

  it("resources/read runs the query and returns its JSON", async () => {
    const res = (await handleMcp(bs.server, { jsonrpc: "2.0", id: 7, method: "resources/read", params: { uri: "rayfold://query/books" } }, null)) as { result: { contents: Array<{ uri: string; mimeType: string; text: string }> } };
    const page = JSON.parse(res.result.contents[0]!.text) as { items: Array<{ id: string }>; hasMore: boolean; total: number };
    expect(page.items.map((b) => b.id)).toEqual(["b1", "b2", "b3", "b4"]);
    expect(page).toMatchObject({ hasMore: false, total: 4 });
    expect(bs.store.calls["Query.books"]).toBe(1);
  });

  it("a resource read is a read: a command named as one is refused, not run", async () => {
    // resources/read is MCP's safe verb. An agent reaching for rayfold://query/placeOrder must not place an order,
    // whatever the URI claims, so the op's kind decides and the name in the path does not.
    const res = (await handleMcp(bs.server, { jsonrpc: "2.0", id: 9, method: "resources/read", params: { uri: "rayfold://query/placeOrder" } }, u1)) as { error?: { code: number; message: string } };
    expect(res.error).toMatchObject({ code: -32602, message: "Unknown resource rayfold://query/placeOrder" });
    expect(bs.store.calls["Command.placeOrder"]).toBeUndefined();
    expect(bs.store.orders.size).toBe(0);
    // guard: a real query at the same shape of URI still runs
    const read = await handleMcp(bs.server, { jsonrpc: "2.0", id: 10, method: "resources/read", params: { uri: "rayfold://query/books" } }, u1);
    expect(bs.store.calls["Query.books"]).toBe(1);
    const [page] = await bs.server.collect({ ops: [{ id: 1, op: "books" }] }, { viewer: u1 });
    expect(read).toEqual({ jsonrpc: "2.0", id: 10, result: { contents: [{ uri: "rayfold://query/books", mimeType: "application/json", text: JSON.stringify((page as { data: unknown }).data) }] } });
  });

  it("the schema resource hides policy expressions unless it is asked to serve them, and can be turned off", async () => {
    const read = (schema?: "redacted" | "full" | "off") =>
      handleMcp(bs.server, { jsonrpc: "2.0", id: 11, method: "resources/read", params: { uri: "rayfold://schema" } }, null, schema ? { schema } : {}) as Promise<{
        result?: { contents: Array<{ text: string }> };
        error?: { code: number };
      }>;

    /** The arguments of every `@allow`/`@deny` in an IR: a policy expression names what a viewer must be to pass it. */
    const policyArgs = (text: string): unknown[] => {
      const found: unknown[] = [];
      JSON.parse(text, (_k, v: unknown) => {
        const o = v as Record<string, unknown> | null;
        if (o && typeof o === "object" && !Array.isArray(o) && (o["name"] === "allow" || o["name"] === "deny") && !("type" in o)) found.push(o["args"]);
        return v;
      });
      return found;
    };

    const redacted = await read();
    expect(JSON.parse(redacted.result!.contents[0]!.text)).toMatchObject({ rayfold: "0.1" }); // still a usable schema
    const hidden = policyArgs(redacted.result!.contents[0]!.text);
    expect(hidden.length).toBeGreaterThan(0); // the bookstore has policies, or this proves nothing
    expect(hidden.every((a) => JSON.stringify(a) === "{}")).toBe(true);

    const full = await read("full");
    expect(policyArgs(full.result!.contents[0]!.text).some((a) => JSON.stringify(a) !== "{}")).toBe(true);

    const off = await read("off");
    expect(off.error).toMatchObject({ code: -32602 });
    expect(mcpResources(bs.server, "off").map((r) => r.uri)).not.toContain("rayfold://schema");
  });

  it("unknown methods and tools are reported, not thrown", async () => {
    expect(await handleMcp(bs.server, { jsonrpc: "2.0", id: 8, method: "nope" }, null)).toEqual({ jsonrpc: "2.0", id: 8, error: { code: -32601, message: "Method not found: nope" } });
    expect(await call("stockUpdates", {})).toMatchObject({ result: { isError: true, content: [{ type: "text", text: "Unknown tool stockUpdates" }] } });
  });
});

describe("MCP over Streamable HTTP", () => {
  let http: Server;
  let url: string;
  beforeEach(async () => {
    const handler = createMcpHandler(bs.server, { viewer: (req) => (req.headers.authorization ? u1 : null) });
    http = createServer((req, res) => void handler(req, res).then((handled) => !handled && res.writeHead(404).end()));
    await new Promise<void>((r) => http.listen(0, r));
    url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  });
  afterEach(() => new Promise<void>((r) => {
    http.close(() => r());
    http.closeAllConnections();
  }));
  const rpc = (body: unknown, headers: Record<string, string> = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  it("initialize answers with the protocol version, capabilities and the schema hash", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-protocol-version")).toBe("2026-07-28");
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2026-07-28", capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } }, serverInfo: { name: "rayfold", version: "0.1", schemaHash: bs.server.hash } },
    });
  });

  it("server/discover answers statelessly; a mismatched Mcp-Method header is refused while a matching one passes (guard)", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "server/discover" });
    expect(await res.json()).toMatchObject({ result: { protocolVersion: "2026-07-28", serverInfo: { name: "rayfold", schemaHash: bs.server.hash } } });
    const bad = await rpc({ jsonrpc: "2.0", id: 2, method: "ping" }, { "mcp-method": "tools/list" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ jsonrpc: "2.0", id: 2, error: { code: -32020, message: "HeaderMismatch" } });
    const good = await rpc({ jsonrpc: "2.0", id: 3, method: "ping" }, { "mcp-method": "ping" });
    expect(await good.json()).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
  });

  it("a notification gets 202 with no body; a batch gets replies for the requests only", async () => {
    const note = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(note.status).toBe(202);
    expect(await note.text()).toBe("");
    const batch = await rpc([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }]);
    const replies = (await batch.json()) as Array<{ id: number }>;
    expect(replies.map((r) => r.id)).toEqual([1, 2]);
  });

  it("a notification other than initialized also gets 202 with no body; the same method as a request is answered (guard)", async () => {
    const note = await rpc({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
    expect(note.status).toBe(202);
    expect(await note.text()).toBe("");
    const asked = await rpc({ jsonrpc: "2.0", id: 5, method: "notifications/cancelled" });
    expect(asked.status).toBe(200);
    expect(await asked.json()).toEqual({ jsonrpc: "2.0", id: 5, error: { code: -32601, message: "Method not found: notifications/cancelled" } });
  });

  it("a body of null, or null inside a batch, is answered -32600 and the handler resolves; the batch's real requests are answered (guard)", async () => {
    const alone = await rpc(null);
    expect(alone.status).toBe(200);
    expect(await alone.json()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
    const batch = await rpc([null, { jsonrpc: "2.0", id: 1, method: "ping" }]);
    expect(await batch.json()).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } },
      { jsonrpc: "2.0", id: 1, result: {} },
    ]);
  });

  it("the HeaderMismatch reply carries MCP-Protocol-Version as every JSON-RPC response does; a parse error, made before the body is understood, does not (guard)", async () => {
    const bad = await rpc({ jsonrpc: "2.0", id: 2, method: "ping" }, { "mcp-method": "tools/list" });
    expect(bad.status).toBe(400);
    expect(bad.headers.get("mcp-protocol-version")).toBe("2026-07-28");
    const broken = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(broken.status).toBe(400);
    expect(broken.headers.get("mcp-protocol-version")).toBeNull();
  });

  it("the viewer hook decides policies for tool calls", async () => {
    const anon = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "placeOrder", arguments: order("b3", 1) } });
    expect(await anon.json()).toMatchObject({ result: { isError: true, structuredContent: { error: { code: "unauthenticated" } } } });
    const signedIn = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "placeOrder", arguments: order("b3", 1) } }, { authorization: "Bearer u1" });
    expect(await signedIn.json()).toMatchObject({ result: { structuredContent: { result: { id: "o1" } } } });
    expect(bs.store.orders.get("o1")).toMatchObject({ customerId: "u1" });
  });

  it("a body one byte over maxBody is refused 413 before anything runs; a body exactly at it is served (guard)", async () => {
    const handler = createMcpHandler(bs.server, { maxBody: 200 });
    const small = createServer((req, res) => void handler(req, res));
    await new Promise<void>((r) => small.listen(0, r));
    try {
      const smallUrl = `http://127.0.0.1:${(small.address() as AddressInfo).port}/mcp`;
      const books = { jsonrpc: "2.0" as const, id: 1, method: "tools/call", params: { name: "books", arguments: {} } };
      const post = (bytes: number) => fetch(smallUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(books).padEnd(bytes, " ") });

      const over = await post(201);
      expect(over.status).toBe(413);
      expect(await over.json()).toEqual({ type: "https://eddyboutros.github.io/rayfold/errors/payload_too_large", title: "payload too large", status: 413, detail: "Body exceeds 200 bytes", code: "resource_exhausted" });
      expect(bs.store.calls["Query.books"]).toBeUndefined();

      const atLimit = await post(200);
      expect(atLimit.status).toBe(200);
      expect(bs.store.calls["Query.books"]).toBe(1);
      expect(await atLimit.json()).toEqual(await handleMcp(bs.server, books, null));
    } finally {
      await new Promise<void>((r) => {
        small.close(() => r());
        small.closeAllConnections();
      });
    }
  });

  it("only POST is accepted and malformed JSON is a parse error", async () => {
    const get = await fetch(url);
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    const broken = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(broken.status).toBe(400);
    expect(await broken.json()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  });
});

/**
 * JSON Schema 2020-12 validation for the keywords the bridge emits (type, $ref, anyOf, properties, required,
 * additionalProperties, items, enum, const), which is what a client validating structuredContent applies.
 * Returns the paths that fail, empty when the value is valid.
 */
function violations(root: Record<string, unknown>, value: unknown): string[] {
  const defs = (root["$defs"] ?? {}) as Record<string, Record<string, unknown>>;
  const out: string[] = [];
  const typeOk = (t: string, v: unknown): boolean =>
    t === "null" ? v === null
    : t === "integer" ? Number.isInteger(v)
    : t === "number" ? typeof v === "number"
    : t === "array" ? Array.isArray(v)
    : t === "object" ? v !== null && typeof v === "object" && !Array.isArray(v)
    : typeof v === t;
  const check = (s: Record<string, unknown>, v: unknown, path: string): boolean => {
    const before = out.length;
    if (typeof s["$ref"] === "string") return check(defs[(s["$ref"] as string).replace("#/$defs/", "")]!, v, path);
    if (Array.isArray(s["anyOf"])) {
      const ok = (s["anyOf"] as Array<Record<string, unknown>>).some((alt) => {
        const mark = out.length;
        const fine = check(alt, v, path);
        out.length = mark;
        return fine;
      });
      if (!ok) out.push(`${path}: matches no anyOf branch`);
      return ok;
    }
    if (s["type"] !== undefined && !(Array.isArray(s["type"]) ? (s["type"] as string[]) : [s["type"] as string]).some((t) => typeOk(t, v))) out.push(`${path}: not ${JSON.stringify(s["type"])}`);
    if ("const" in s && v !== s["const"]) out.push(`${path}: not ${JSON.stringify(s["const"])}`);
    if (Array.isArray(s["enum"]) && !(s["enum"] as unknown[]).includes(v)) out.push(`${path}: not in enum`);
    if (Array.isArray(v) && s["items"]) v.forEach((x, i) => check(s["items"] as Record<string, unknown>, x, `${path}[${i}]`));
    if (v && typeof v === "object" && !Array.isArray(v) && s["properties"]) {
      const props = s["properties"] as Record<string, Record<string, unknown>>;
      for (const r of (s["required"] ?? []) as string[]) if (!(r in v)) out.push(`${path}.${r}: required`);
      for (const [k, x] of Object.entries(v)) {
        if (props[k]) check(props[k]!, x, `${path}.${k}`);
        else if (s["additionalProperties"] === false) out.push(`${path}.${k}: not allowed`);
      }
    }
    return out.length === before;
  };
  check(root, value, "$");
  return out;
}

describe("a tool's outputSchema describes what tools/call returns", () => {
  it("the default-view result of each query tool validates against its outputSchema", async () => {
    const tools = mcpTools(bs.server);
    const calls: Array<[string, Record<string, unknown>]> = [["book", { id: "b1" }], ["books", {}], ["author", { id: "a1" }]];
    for (const [name, args] of calls) {
      const reply = (await call(name, args, u1)) as Reply;
      const structured = reply.result["structuredContent"];
      expect(structured, name).toMatchObject({ result: expect.anything() });
      expect([name, violations(tools.find((t) => t.name === name)!.outputSchema!, structured)]).toEqual([name, []]);
    }
  });

  it("guard: it still says what a result holds: an unknown member, a wrong $type or a wrong type is refused", async () => {
    // the tool's own Book definition, taken out of the nullable result so a failure names the member at fault
    const { $defs } = mcpTools(bs.server).find((t) => t.name === "book")!.outputSchema! as { $defs: Record<string, unknown> };
    const schema = { $defs, type: "object", properties: { result: { $ref: "#/$defs/Book" } }, required: ["result"] };
    const reply = (await call("book", { id: "b1" }, u1)) as Reply;
    const book = (reply.result["structuredContent"] as { result: Record<string, unknown> }).result;
    expect(violations(schema, { result: { ...book, extra: 1 } })).toEqual(["$.result.extra: not allowed"]);
    expect(violations(schema, { result: { ...book, $type: "Author" } })).toEqual(['$.result.$type: not "Book"']);
    expect(violations(schema, { result: { ...book, title: 7 } })).toEqual(['$.result.title: not "string"']);
    expect(violations(schema, {})).toEqual(["$.result: required"]);
    // and the input schema, which a caller must satisfy in full, still requires what an op needs
    expect(mcpTools(bs.server).find((t) => t.name === "book")!.inputSchema).toMatchObject({ required: ["id"] });
  });
});

describe("JSON-RPC bodies that are not requests", () => {
  it("a request that is null is answered -32600, not thrown", async () => {
    expect(await handleMcp(bs.server, null as never, null)).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
    expect(await handleMcp(bs.server, 7 as never, null)).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
  });

  it("a notification of any method gets no reply; the same method with an id is answered (guard)", async () => {
    expect(await handleMcp(bs.server, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 3 } } as never, null)).toBeNull();
    expect(await handleMcp(bs.server, { jsonrpc: "2.0", id: 4, method: "notifications/cancelled" }, null)).toEqual({ jsonrpc: "2.0", id: 4, error: { code: -32601, message: "Method not found: notifications/cancelled" } });
  });
});

describe("resource arguments from the URI", () => {
  const notes = () =>
    createRayfoldServer({
      schema: `entity Note { id: ID n: Int } query notes(limit: Int = 3, desc: Boolean = false): [Note]`,
      resolvers: {
        Query: {
          notes: ({ limit, desc }: { limit: number; desc: boolean }) => {
            const all = [1, 2, 3, 4].map((n) => ({ id: `n${n}`, n }));
            return (desc ? all.reverse() : all).slice(0, limit);
          },
        },
      } as never,
    });
  const read = (server: RayfoldServer, uri: string) =>
    handleMcp(server, { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri } }, null) as Promise<{ result?: { contents: Array<{ text: string }> }; error?: { code: number; message: string } }>;

  it("are coerced by the declared type, as an HTTP binding's query string is", async () => {
    const res = await read(notes(), "rayfold://query/notes?limit=2&desc=true");
    expect(res.error).toBeUndefined();
    expect(JSON.parse(res.result!.contents[0]!.text)).toEqual([{ $type: "Note", id: "n4", n: 4 }, { $type: "Note", id: "n3", n: 3 }]);
  });

  it("guard: text that is no Int is still refused, rather than coerced to something", async () => {
    const res = await read(notes(), "rayfold://query/notes?limit=two");
    expect(res.result).toBeUndefined();
    expect(res.error).toMatchObject({ code: -32000, message: expect.stringContaining("invalid_argument") });
  });
});
