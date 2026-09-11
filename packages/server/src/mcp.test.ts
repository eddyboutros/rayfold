import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createBookstore } from "../../../examples/bookstore-ts/src/index.ts";
import { createMcpHandler, handleMcp, mcpResources, mcpTools } from "./mcp.ts";
import { createRayfoldServer, type RayfoldServer } from "./server.ts";

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

  it("the viewer hook decides policies for tool calls", async () => {
    const anon = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "placeOrder", arguments: order("b3", 1) } });
    expect(await anon.json()).toMatchObject({ result: { isError: true, structuredContent: { error: { code: "unauthenticated" } } } });
    const signedIn = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "placeOrder", arguments: order("b3", 1) } }, { authorization: "Bearer u1" });
    expect(await signedIn.json()).toMatchObject({ result: { structuredContent: { result: { id: "o1" } } } });
    expect(bs.store.orders.get("o1")).toMatchObject({ customerId: "u1" });
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
