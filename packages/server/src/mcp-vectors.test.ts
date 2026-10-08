import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpHandler } from "./mcp.ts";
import { createRayfoldServer } from "./server.ts";

/**
 * The published `mcp/` vectors, run against this runtime's Streamable HTTP endpoint on a real socket.
 * `McpVectorsTest.kt` runs the same file against the JVM.
 */
const PATH = new URL("../../../conformance/vectors/mcp/bridge.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
type Expect = Record<string, unknown>;
type Step = { request: { json?: unknown; headers?: Record<string, string>; oversize?: number }; expect: Expect };
type Case = { name: string; why?: string; steps: Step[]; runs?: Record<string, number> };
const doc = JSON.parse(readFileSync(PATH, "utf8")) as { schema: string; cases: Case[] };

const CASE_KEYS = new Set(["name", "why", "steps", "runs"]);
const REQUEST_KEYS = new Set(["json", "headers", "oversize"]);
const EXPECT_KEYS = new Set(["status", "headers", "noBody", "error", "batchErrors", "resourceItems", "isError", "validatesOutputSchemaOf", "problem"]);

const open: Server[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => new Promise<void>((r) => {
    h.close(() => r());
    h.closeAllConnections();
  })));
});

function serve() {
  const runs: Record<string, number> = { restock: 0, reserve: 0 };
  const book = (id: string) => ({ id, title: "T", author: { id: "a1", name: "A" } });
  const command = (name: string) => (args: { id: string }) => {
    runs[name]!++;
    return book(args.id);
  };
  const server = createRayfoldServer({
    schema: doc.schema,
    resolvers: {
      Query: { book: (a: { id: string }) => book(a.id), books: (a: { limit: number }) => ["b1", "b2", "b3"].map(book).slice(0, a.limit) },
      Command: { restock: command("restock"), reserve: command("reserve") },
    },
  });
  const mcp = createMcpHandler(server, { viewer: () => ({ id: "u1" }) });
  const http = createServer((req, res) => {
    void mcp(req, res).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  open.push(http);
  return new Promise<{ url: string; runs: Record<string, number> }>((resolve) =>
    http.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`, runs })),
  );
}

async function post(url: string, request: Step["request"]): Promise<Response> {
  const body = request.oversize !== undefined
    ? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }).padEnd(request.oversize, " ")
    : JSON.stringify(request.json);
  return fetch(url, { method: "POST", headers: { "content-type": "application/json", ...request.headers }, body });
}

/** Just enough JSON Schema 2020-12 for a tool's outputSchema: $ref, anyOf, const, type, properties, required, items. */
function violations(schema: Record<string, unknown>, value: unknown, defs: Record<string, Record<string, unknown>>, at: string): string[] {
  if (typeof schema["$ref"] === "string") return violations(defs[(schema["$ref"] as string).replace("#/$defs/", "")]!, value, defs, at);
  if (Array.isArray(schema["anyOf"])) {
    const each = (schema["anyOf"] as Array<Record<string, unknown>>).map((s) => violations(s, value, defs, at));
    return each.some((v) => v.length === 0) ? [] : each.flat();
  }
  if ("const" in schema) return value === schema["const"] ? [] : [`${at}: not ${JSON.stringify(schema["const"])}`];
  const type = schema["type"];
  if (type === "null") return value === null ? [] : [`${at}: not null`];
  if (type === "string") return typeof value === "string" ? [] : [`${at}: not a string`];
  if (type === "integer") return Number.isInteger(value) ? [] : [`${at}: not an integer`];
  if (type === "number") return typeof value === "number" ? [] : [`${at}: not a number`];
  if (type === "boolean") return typeof value === "boolean" ? [] : [`${at}: not a boolean`];
  if (type === "array") {
    if (!Array.isArray(value)) return [`${at}: not an array`];
    return value.flatMap((v, i) => violations(schema["items"] as Record<string, unknown>, v, defs, `${at}[${i}]`));
  }
  if (type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return [`${at}: not an object`];
    const o = value as Record<string, unknown>;
    const props = (schema["properties"] ?? {}) as Record<string, Record<string, unknown>>;
    const out = ((schema["required"] ?? []) as string[]).filter((k) => !(k in o)).map((k) => `${at}.${k}: required and missing`);
    for (const [k, v] of Object.entries(o)) {
      if (props[k]) out.push(...violations(props[k]!, v, defs, `${at}.${k}`));
      else if (schema["additionalProperties"] === false) out.push(`${at}.${k}: not a declared property`);
    }
    return out;
  }
  throw new Error(`${at}: the vector runner has no check for schema ${JSON.stringify(schema)}`);
}

describe("conformance vectors: mcp", () => {
  for (const c of doc.cases) {
    it(c.name, async () => {
      for (const k of Object.keys(c)) expect(CASE_KEYS.has(k), `${c.name}: no runner for case field ${k}`).toBe(true);
      const { url, runs } = await serve();
      const why = c.why ?? c.name;
      for (const step of c.steps) {
        for (const k of Object.keys(step.request)) expect(REQUEST_KEYS.has(k), `${c.name}: no runner for request field ${k}`).toBe(true);
        for (const k of Object.keys(step.expect)) expect(EXPECT_KEYS.has(k), `${c.name}: no assertion for expect.${k}`).toBe(true);
        const res = await post(url, step.request);
        const text = await res.text();
        const e = step.expect;
        if (e["status"] !== undefined) expect(res.status, why).toBe(e["status"]);
        for (const [h, v] of Object.entries((e["headers"] ?? {}) as Record<string, string>)) expect(res.headers.get(h), `${why}: header ${h}`).toBe(v);
        if (e["noBody"] === true) expect(text, why).toBe("");
        const reply = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
        if (e["error"] !== undefined) expect((reply?.["error"] as { code?: number } | undefined)?.code, why).toBe(e["error"]);
        if (e["batchErrors"] !== undefined) {
          expect(Array.isArray(reply), `${why}: a batch is answered with an array`).toBe(true);
          expect((reply as unknown as Array<{ error?: { code: number } }>).map((r) => r.error?.code ?? null), why).toEqual(e["batchErrors"]);
        }
        if (e["problem"] !== undefined) {
          const p = e["problem"] as { type: string; code: string };
          expect(res.headers.get("content-type"), why).toContain("application/problem+json");
          expect(String(reply?.["type"]), why).toContain(p.type);
          expect(reply?.["code"], why).toBe(p.code);
        }
        const result = reply?.["result"] as Record<string, unknown> | undefined;
        if (e["resourceItems"] !== undefined) {
          expect(reply?.["error"], why).toBeUndefined();
          const contents = result?.["contents"] as Array<{ text: string }>;
          expect((JSON.parse(contents[0]!.text) as unknown[]).length, why).toBe(e["resourceItems"]);
        }
        if (e["isError"] !== undefined) expect(result?.["isError"] ?? false, `${why}: ${text}`).toBe(e["isError"]);
        if (e["validatesOutputSchemaOf"] !== undefined) {
          const listed = await post(url, { json: { jsonrpc: "2.0", id: 99, method: "tools/list" } });
          const tools = ((await listed.json()) as { result: { tools: Array<{ name: string; outputSchema: Record<string, unknown> }> } }).result.tools;
          const schema = tools.find((t) => t.name === e["validatesOutputSchemaOf"])!.outputSchema;
          const defs = (schema["$defs"] ?? {}) as Record<string, Record<string, unknown>>;
          expect(violations(schema, result?.["structuredContent"], defs, "structuredContent"), why).toEqual([]);
        }
      }
      if (c.runs) expect(runs, why).toEqual(c.runs);
    });
  }
});
