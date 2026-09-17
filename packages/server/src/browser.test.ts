/**
 * `@rayfold/server/core` has to run where there is no Node: a browser tab, a worker, the documentation playground.
 * These tests bundle it for the browser and run real batches inside a VM context that holds only what a browser
 * offers, so a stray node: import, Buffer or process fails here rather than in someone's page.
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const srcDir = fileURLToPath(new URL(".", import.meta.url));
const ENTRY_NAME = "entry.ts";

async function bundle(entry: string): Promise<{ code: string; inputs: string[] }> {
  const out = await build({
    stdin: { contents: entry, resolveDir: srcDir, loader: "ts", sourcefile: ENTRY_NAME },
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "entry",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  return { code: out.outputFiles[0]!.text, inputs: Object.keys(out.metafile.inputs) };
}

/** The globals a page has. Node's own (Buffer, process, require, setImmediate) are left out on purpose. */
function browserGlobals(): Record<string, unknown> {
  const g = globalThis as Record<string, unknown>;
  const names = ["TextEncoder", "TextDecoder", "URL", "URLSearchParams", "AbortController", "AbortSignal", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask", "structuredClone", "crypto", "performance", "atob", "btoa", "console"];
  return Object.fromEntries(names.map((n) => [n, g[n]]));
}

async function runInPage(code: string): Promise<unknown> {
  const context = browserGlobals();
  runInNewContext(code, context);
  const json = await (context["entry"] as { main(): Promise<string> }).main();
  return JSON.parse(json);
}

const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

// The bytes are made inside the bundle: a Uint8Array from the host's TextEncoder belongs to another realm, which a
// page never hands its own server.
const ENTRY = `
import { createRayfoldServer } from "./core.ts";

const files = new Map([["f1", { id: "f1", name: "a.txt", data: Uint8Array.of(104, 101, 108, 108, 111) }]]);
const server = createRayfoldServer({
  schema: \`
    entity File { id: ID name: String data: Bytes }
    query file(id: ID): File?
    command rename(id: ID, name: String): File @allow(write: viewer != null)
  \`,
  resolvers: {
    Query: { file: ({ id }) => files.get(id) ?? null },
    Command: { rename: ({ id, name }) => Object.assign(files.get(id), { name }) },
  },
});

async function collect(envelope, viewer) {
  const frames = [];
  for await (const f of server.execute(envelope, { viewer })) frames.push(f);
  return frames;
}

export async function main() {
  const read = await collect({ rayfold: "0.1", ops: [{ id: 1, op: "file", args: { id: "f1" }, shape: "{ id name data }" }] }, null);
  const rename = { rayfold: "0.1", ops: [{ id: 1, op: "rename", args: { id: "f1", name: "b.txt" }, key: "k-0123456789abcdef" }] };
  const renamed = await collect(rename, { id: "u1" });
  const narrowed = await collect({ ...rename, ops: [{ ...rename.ops[0], key: "k-fedcba9876543210" }] }, { id: "u1", caps: { ops: ["file"] } });
  return JSON.stringify({ read, renamed, narrowed });
}
`;

describe("the server core in a browser", () => {
  it("bundles for the browser from sources that use nothing Node-only", async () => {
    const { inputs } = await bundle(ENTRY);
    // esbuild names the stdin entry after its directory, and it is not a file on disk
    const ours = inputs.filter((p) => !p.endsWith(ENTRY_NAME) && !p.includes("node_modules"));
    expect(ours).toEqual(expect.arrayContaining([expect.stringMatching(/server\/src\/batch\.ts$/), expect.stringMatching(/schema\/src\/canonical\.ts$/)]));
    const nodeOnly = ours.filter((p) => /\bBuffer\b|\bprocess\.|from "node:/.test(stripComments(readFileSync(p, "utf8"))));
    expect(nodeOnly).toEqual([]);
  });

  it("answers a query, applies a command and enforces a capability with only browser globals", async () => {
    const { code } = await bundle(ENTRY);
    const result = (await runInPage(code)) as { read: unknown[]; renamed: unknown[]; narrowed: unknown[] };
    expect(result.read).toMatchObject([{ id: 1, data: { id: "f1", name: "a.txt", data: "aGVsbG8" } }]);
    expect(result.renamed).toMatchObject([{ id: 1, ok: { id: "f1", name: "b.txt" } }]);
    expect(result.narrowed).toMatchObject([{ id: 1, error: { code: "permission_denied" } }]);
  });

  it("the fetch handler bundles for a runtime with no Node at all", async () => {
    // what a Worker, Deno or Bun imports: the endpoint itself, not only the executor
    const { inputs } = await bundle(`import { createFetchHandler } from "./fetch.ts"; export const main = () => createFetchHandler;`);
    const ours = inputs.filter((p) => !p.endsWith(ENTRY_NAME) && !p.includes("node_modules"));
    expect(ours).toEqual(expect.arrayContaining([expect.stringMatching(/server\/src\/fetch\.ts$/)]));
    const nodeOnly = ours.filter((p) => /\bBuffer\b|\bprocess\.|from "node:/.test(stripComments(readFileSync(p, "utf8"))));
    expect(nodeOnly).toEqual([]);
  });

  it("guard: the checks do fail for Node-only code, so passing them means something", async () => {
    await expect(bundle(`import { listen } from "./http.ts"; export const main = () => listen;`)).rejects.toThrow(/node:http/);
    expect(() => runInNewContext(`Buffer.from("x")`, browserGlobals())).toThrow(/Buffer is not defined/);
  });
});
