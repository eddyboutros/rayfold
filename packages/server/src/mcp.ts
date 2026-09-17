/**
 * MCP bridge (spec 10): any Rayfold server is an MCP server.
 * Streamable HTTP, stateless (revision 2026-07-28): POST JSON-RPC to /mcp, JSON response.
 * commands -> tools (plus a `simulate` variant), queries -> tools and resources, schema docs -> descriptions.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { annotation, baseName, type ArgDef, type FieldDef, type OpDef, type RayfoldSchemaIR, type TypeRef } from "@rayfold/schema";
import type { RayfoldServer } from "./server.ts";
import type { Frame } from "./protocol.ts";
import { jsonSchemaFor, withRange } from "./json-schema.ts";
import { publicIR } from "./fetch.ts";

export { jsonSchemaFor, withRange };
import { hostProblem, mediaType, originProblem, refuse, type OriginOptions } from "./guard.ts";

export const MCP_PROTOCOL_VERSION = "2026-07-28";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
}

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType: string;
}

/** JSON Schema 2020-12 for a Rayfold type reference. */

function argsSchema(ir: RayfoldSchemaIR, args: ArgDef[]): Record<string, unknown> {
  const defs: Record<string, unknown> = {};
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const a of args) {
    const s = withRange(jsonSchemaFor(ir, a.type, defs, true), a.annotations, baseName(a.type));
    properties[a.name] = a.description ? { ...s, description: a.description } : s;
    if (!a.type.nullable && a.default === undefined) required.push(a.name);
  }
  const schema: Record<string, unknown> = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties, additionalProperties: false };
  if (required.length) schema["required"] = required;
  if (Object.keys(defs).length) schema["$defs"] = defs;
  return schema;
}

function resultSchema(ir: RayfoldSchemaIR, t: TypeRef): Record<string, unknown> {
  const defs: Record<string, unknown> = {};
  const inner = jsonSchemaFor(ir, t, defs, false);
  const schema: Record<string, unknown> = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { result: inner }, required: ["result"] };
  if (Object.keys(defs).length) schema["$defs"] = defs;
  return schema;
}

export function mcpTools(server: RayfoldServer): McpTool[] {
  const ir = server.ir;
  const tools: McpTool[] = [];
  for (const op of Object.values(ir.ops)) {
    if (op.kind === "stream") continue;
    const base: McpTool = { name: op.name, inputSchema: argsSchema(ir, op.args), outputSchema: resultSchema(ir, op.returns) };
    const desc = [op.description, op.throws.length ? `May fail with: ${op.throws.join(", ")}.` : "", op.kind === "query" ? "Read-only." : "Changes state; idempotent per call key."].filter(Boolean).join(" ");
    if (desc) base.description = desc;
    base.annotations = op.kind === "query" ? { readOnlyHint: true, idempotentHint: true } : { readOnlyHint: false, destructiveHint: true, idempotentHint: true };
    tools.push(base);
    // A dry-run tool is offered only where the command declares @simulate: the runtime cannot stop a resolver that ignores ctx.simulate.
    if (op.kind === "command" && op.annotations.some((a) => a.name === "simulate")) {
      tools.push({
        ...base,
        name: `${op.name}.simulate`,
        description: `Dry run of ${op.name}: returns the would-be result and effects without committing.`,
        annotations: { readOnlyHint: true, idempotentHint: true },
      });
    }
  }
  return tools;
}

export function mcpResources(server: RayfoldServer, schema: SchemaMode = "redacted"): McpResource[] {
  const out: McpResource[] = [];
  if (schema !== "off") out.push({ uri: "rayfold://schema", name: "Rayfold schema (IR)", description: "The schema as JSON IR", mimeType: "application/json" });
  for (const op of Object.values(server.ir.ops)) {
    if (op.kind !== "query" || op.args.some((a) => !a.type.nullable && a.default === undefined)) continue;
    const r: McpResource = { uri: `rayfold://query/${op.name}`, name: op.name, mimeType: "application/json" };
    if (op.description) r.description = op.description;
    out.push(r);
  }
  return out;
}

async function callTool(server: RayfoldServer, name: string, args: Record<string, unknown>, viewer: unknown): Promise<Record<string, unknown>> {
  const simulate = name.endsWith(".simulate");
  const opName = simulate ? name.slice(0, -".simulate".length) : name;
  const op = server.ir.ops[opName];
  if (!op || op.kind === "stream") return { isError: true, content: [{ type: "text", text: `Unknown tool ${name}` }] };
  const req: import("./protocol.ts").RequestOp = { id: 1, op: opName, args };
  if (op.kind === "command") {
    const optedOut = op.annotations.some((a) => a.name === "idempotent" && a.args["value"] === false);
    if (!optedOut) req.key = `mcp-${hashKey(JSON.stringify(args))}`;
    if (simulate) req.simulate = true;
  }
  const frames = await server.collect({ ops: [req], meta: { client: "mcp" } }, { viewer });
  const data = foldForMcp(frames);
  if ("error" in data) {
    const e = data.error;
    return { isError: true, content: [{ type: "text", text: `${e.code}${e.type ? ` ${e.type}` : ""}: ${e.message}` }], structuredContent: { error: e } };
  }
  const structured: Record<string, unknown> = { result: data.result };
  if (data.patch) structured["effects"] = data.patch;
  return { content: [{ type: "text", text: JSON.stringify(structured.result, null, 2) }], structuredContent: structured, resultType: "complete" };
}

function foldForMcp(frames: Frame[]): { result: unknown; patch?: unknown } | { error: { code: string; type?: string; message: string; data?: unknown } } {
  let result: unknown;
  let patch: unknown;
  for (const f of frames) {
    if ("error" in f) return { error: f.error };
    if ("ok" in f) {
      result = f.ok;
      patch = f.patch;
    } else if ("data" in f && !("at" in f)) result = f.data;
    else if ("at" in f && result && typeof result === "object") {
      const target = f.at === "" ? result : getPath(result, f.at.split("."));
      if (target && typeof target === "object") Object.assign(target as object, f.data as object);
    }
  }
  return patch !== undefined ? { result, patch } : { result };
}

function getPath(v: unknown, path: string[]): unknown {
  let cur = v;
  for (const p of path) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = Array.isArray(cur) ? cur[Number(p)] : (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function hashKey(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0") + s.length.toString(16).padStart(8, "0");
}

/**
 * What `rayfold://schema` serves: the IR without policy expressions (the default), the whole IR, or nothing at all
 * (spec 12 §5.6). A policy expression names the fields and viewer attributes that decide an answer, which tells a
 * caller what to probe, so it is not part of what a schema has to disclose to be useful.
 */
export type SchemaMode = "redacted" | "full" | "off";

/** Handle one JSON-RPC request (stateless). */
export async function handleMcp(server: RayfoldServer, req: JsonRpcRequest, viewer: unknown, opts: { schema?: SchemaMode } = {}): Promise<Record<string, unknown> | null> {
  const schemaMode = opts.schema ?? "redacted";
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: req.id ?? null, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: req.id ?? null, error: { code, message } });
  const p = req.params ?? {};
  switch (req.method) {
    case "initialize":
      return reply({ protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } }, serverInfo: { name: "rayfold", version: "0.1", schemaHash: server.hash } });
    case "server/discover":
      return reply({ protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {}, resources: {} }, serverInfo: { name: "rayfold", version: "0.1", schemaHash: server.hash } });
    case "ping":
      return reply({});
    case "notifications/initialized":
      return null;
    case "tools/list":
      return reply({ tools: mcpTools(server), ttlMs: 300_000, cacheScope: "public" });
    case "tools/call": {
      const name = p["name"];
      if (typeof name !== "string") return fail(-32602, "name is required");
      return reply(await callTool(server, name, (p["arguments"] as Record<string, unknown>) ?? {}, viewer));
    }
    case "resources/list":
      return reply({ resources: mcpResources(server, schemaMode), ttlMs: 300_000, cacheScope: "public" });
    case "resources/read": {
      const uri = p["uri"];
      if (typeof uri !== "string") return fail(-32602, "uri is required");
      if (uri === "rayfold://schema" && schemaMode !== "off") {
        const ir = schemaMode === "full" ? server.ir : publicIR(server.ir);
        return reply({ contents: [{ uri, mimeType: "application/json", text: JSON.stringify(ir) }] });
      }
      const m = /^rayfold:\/\/query\/([A-Za-z_][A-Za-z0-9_]*)(\?(.*))?$/.exec(uri);
      // reading a resource is a read: the operation's kind decides, not the name in the URI, so a command named
      // here is refused rather than run. Otherwise MCP's one safe verb becomes a way to write.
      if (!m || server.ir.ops[m[1]!]?.kind !== "query") return fail(-32602, `Unknown resource ${uri}`);
      const args: Record<string, unknown> = {};
      for (const [k, v] of new URLSearchParams(m[3] ?? "")) args[k] = v;
      const r = await callTool(server, m[1]!, args, viewer);
      if (r["isError"]) return fail(-32000, (r["content"] as Array<{ text: string }>)[0]?.text ?? "error");
      return reply({ contents: [{ uri, mimeType: "application/json", text: JSON.stringify((r["structuredContent"] as { result: unknown }).result) }] });
    }
    case "prompts/list":
      return reply({ prompts: [] });
    default:
      return fail(-32601, `Method not found: ${req.method}`);
  }
}

export interface McpHttpOptions extends OriginOptions {
  path?: string;
  viewer?: (req: IncomingMessage) => unknown | Promise<unknown>;
  /** What `rayfold://schema` serves. Default `"redacted"`: the IR without policy expressions (spec 12 §5.6). */
  schema?: SchemaMode;
}

/** Streamable HTTP endpoint: POST JSON-RPC, JSON reply. */
export function createMcpHandler(server: RayfoldServer, opts: McpHttpOptions = {}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const path = opts.path ?? "/mcp";
  server.mounted.add("mcp");
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== path) return false;
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST", "X-Content-Type-Options": "nosniff" }).end();
      return true;
    }
    // The MCP transport requires Origin validation: without it any web page could drive a local or intranet server.
    const refused = hostProblem(req, opts) ?? originProblem(req, opts);
    if (refused) {
      refuse(res, 403, "permission_denied", refused);
      return true;
    }
    if (mediaType(req) !== "application/json") {
      refuse(res, 415, "invalid_argument", `Content-Type ${mediaType(req) || "(none)"} is not accepted; send application/json`, "unsupported_media_type");
      return true;
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: JsonRpcRequest | JsonRpcRequest[];
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
      return true;
    }
    const viewer = opts.viewer ? await opts.viewer(req) : null;
    const headerMethod = req.headers["mcp-method"];
    const first = Array.isArray(body) ? body[0] : body;
    if (typeof headerMethod === "string" && first && headerMethod !== first.method) {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: first.id ?? null, error: { code: -32020, message: "HeaderMismatch" } }));
      return true;
    }
    const results = await Promise.all((Array.isArray(body) ? body : [body]).map((r) => handleMcp(server, r, viewer, { schema: opts.schema ?? "redacted" })));
    const out = Array.isArray(body) ? results.filter(Boolean) : results[0];
    res.setHeader("MCP-Protocol-Version", MCP_PROTOCOL_VERSION);
    if (out === null || out === undefined) {
      res.writeHead(202).end();
      return true;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(out));
    return true;
  };
}

export { annotation as _annotation };
