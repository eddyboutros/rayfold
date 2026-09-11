#!/usr/bin/env node
/**
 * Installs the built packages from their tarballs into a fresh project outside this repository and checks that
 * they work there the way the READMEs say:
 *   - the server and client README examples run under plain Node (no tsx): a query, a command whose patch reaches
 *     watch() without a refetch, a batch whose second op reads the first op's result, an anonymous command refused;
 *   - the builder, RB codec and conformance fixtures load from their published entry points;
 *   - the `rayfold` binary validates a schema and generates types;
 *   - a TypeScript project type-checks against the published .d.ts files with skipLibCheck off, once as a Node
 *     project and once as a browser project without Node types;
 *   - the client bundles for the browser (esbuild, platform "browser") without any node: module.
 *
 *   node scripts/build.mjs && node scripts/smoke-packages.mjs [--keep]
 */
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGES } from "./packages.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fromRoot = createRequire(join(ROOT, "package.json"));
const tsc = fromRoot.resolve("typescript/bin/tsc");
const esbuild = fromRoot("esbuild");
const work = mkdtempSync(join(tmpdir(), "rayfold-smoke-"));
const app = join(work, "app");
const sh = (cmd, cwd = app) => execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const step = (what) => console.log(`- ${what}`);

const SCHEMA = `entity Book {
  id: ID
  title: String
  stock: Int
}
query book(id: ID): Book?
command restock(id: ID, qty: Int): Book
`;

// The @rayfold/server and @rayfold/client README examples, with assertions and a request counter.
const EXAMPLE = `import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { createRayfoldServer, listen } from "@rayfold/server";
import { RayfoldClient, RayfoldClientError, createFetchTransport } from "@rayfold/client";
import { loadSchema } from "@rayfold/schema";
import { RbCodec } from "@rayfold/rb";
import { defineSchema, entity, query, t, type Infer } from "@rayfold/builder";
import { groupFrames } from "@rayfold/conformance";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { RayfoldProvider, useQuery } from "@rayfold/react";

interface Book { id: string; title: string; stock: number }
const books = new Map<string, Book>([["b1", { id: "b1", title: "Dune", stock: 3 }]]);

const server = createRayfoldServer({
  schema: ${JSON.stringify(SCHEMA)},
  resolvers: {
    Query: {
      book: ({ id }: { id: string }) => books.get(id) ?? null,
    },
    Command: {
      restock: ({ id, qty }: { id: string; qty: number }) => {
        const book = books.get(id);
        if (!book) throw new Error(\`no book \${id}\`);
        book.stock += qty;
        return book;
      },
    },
  },
});
const http = await listen(server, 0, {
  viewer: (req) => (req.headers.authorization === "Bearer demo" ? { id: "demo-user" } : null),
});
const url = \`http://127.0.0.1:\${(http.address() as AddressInfo).port}/rayfold\`;

try {
  let requests = 0;
  const client = new RayfoldClient({
    transport: createFetchTransport({
      url,
      headers: () => ({ authorization: "Bearer demo" }),
      fetch: (input, init) => {
        requests++;
        return fetch(input, init);
      },
    }),
  });

  const book = await client.query<Book>("book", { id: "b1" });
  assert.equal(book.title, "Dune");
  assert.equal(book.stock, 3);

  // watch(): resolve one pending promise per callback, each bounded to 5 s
  const waiting: Array<(stock: number) => void> = [];
  const next = () => new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("watch() did not call back within 5 s")), 5000);
    waiting.push((stock) => { clearTimeout(timer); resolve(stock); });
  });
  const initial = next();
  const stop = client.watch<Book>("book", { id: "b1" }, {}, (b) => waiting.shift()?.(b.stock));
  assert.equal(await initial, 3);
  const beforeCommand = requests;
  const patched = next();
  await client.command("restock", { id: "b1", qty: 5 });
  assert.equal(await patched, 8, "the command's patch reached watch()");
  assert.equal(requests, beforeCommand + 1, "only the command went over the wire; the watched book was not refetched");
  stop();

  const batch = client.batch();
  const restocked = batch.command<Book>("restock", { id: "b1", qty: 1 });
  const reread = batch.query<Book>("book", { id: restocked.ref("id") });
  const beforeBatch = requests;
  await batch.run();
  assert.equal((await reread.promise).stock, 9);
  assert.equal(requests, beforeBatch + 1, "both ops in one round trip");

  const anonymous = new RayfoldClient({ transport: createFetchTransport({ url }) });
  await assert.rejects(anonymous.command("restock", { id: "b1", qty: 100 }), (e: unknown) => e instanceof RayfoldClientError && e.code === "unauthenticated");
  assert.equal(books.get("b1")?.stock, 9, "the refused command changed nothing");

  // the other packages, from their published entry points
  const { ir } = loadSchema(${JSON.stringify(SCHEMA)});
  const codec = new RbCodec(ir);
  const envelope = { rayfold: "0.1", ops: [{ id: 1, op: "book", args: { id: "b1" } }] };
  assert.deepEqual(codec.decode(codec.encode(envelope)), envelope);

  const schema = defineSchema({ types: [entity("Book", { id: t.id(), title: t.string() })], ops: { book: query({ id: t.id() }, t.ref("Book").nullable()) } });
  const typed: Infer<typeof schema, "Book"> = { $type: "Book", id: "b1", title: "Dune" };
  assert.equal(typed.title, "Dune");
  assert.ok(schema.ir.ops["book"]);

  const fixtures = join(dirname(createRequire(import.meta.url).resolve("@rayfold/conformance/package.json")), "fixtures", "core");
  assert.equal(readdirSync(fixtures).length, ${readdirSync(join(ROOT, "conformance", "fixtures", "core")).length});
  assert.deepEqual(Object.keys(groupFrames([{ id: 1, data: null, fin: true }] as never)), ["1"]);

  // @rayfold/react on the server: the loading state, and no request
  function Title() {
    const { data, loading } = useQuery<Book>("book", { id: "b1" });
    return createElement("p", null, loading ? "loading" : data?.title);
  }
  const beforeRender = requests;
  assert.match(renderToString(createElement(RayfoldProvider, { client }, createElement(Title))), /loading/);
  assert.equal(requests, beforeRender);
  console.log("example ok");
} finally {
  http.closeAllConnections();
  http.close();
}
`;

// A browser page's code: no Node types, no Node modules.
const BROWSER = `import { RayfoldClient, createFetchTransport, createWebSocketTransport } from "@rayfold/client";
import { loadSchema, shapeIdOf } from "@rayfold/schema";
import { RbCodec } from "@rayfold/rb";
import { defineSchema, entity, query, t } from "@rayfold/builder";
import { createElement } from "react";
import { RayfoldProvider, useCommand, useLive, useQuery } from "@rayfold/react";

const { ir } = loadSchema(${JSON.stringify(SCHEMA)});
export const client = new RayfoldClient({ transport: createFetchTransport({ url: "/rayfold", binary: ir }), schema: ir });
export const socket = () => createWebSocketTransport({ url: "wss://example.test/rayfold/ws" });
export const codec = new RbCodec(ir);
export const id = shapeIdOf("{ id title }");
export const schema = defineSchema({ types: [entity("Book", { id: t.id() })], ops: { book: query({ id: t.id() }, t.ref("Book").nullable()) } });

export function BookCard(props: { id: string }) {
  const { data } = useQuery<{ title: string }>("book", { id: props.id });
  const live = useLive<{ stock: number }>("book", { id: props.id }, { shape: "{ id stock }" });
  const [restock, restocking] = useCommand<{ stock: number }>("restock");
  return createElement("button", { disabled: restocking.running, onClick: () => void restock({ id: props.id, qty: 1 }) }, \`\${data?.title} \${live.data?.stock}\`);
}
export const app = createElement(RayfoldProvider, { client }, createElement(BookCard, { id: "b1" }));
`;

let ok = false;
try {
  step(`pack ${PACKAGES.length} packages`);
  const deps = {};
  for (const p of PACKAGES) {
    const dist = join(ROOT, p.dir, "dist");
    const name = JSON.parse(readFileSync(join(dist, "package.json"), "utf8")).name;
    const [{ filename }] = JSON.parse(sh(`npm pack "${dist}" --pack-destination "${work}" --json`, work));
    deps[name] = `file:../${filename}`;
  }

  step("install the tarballs into a fresh project");
  mkdirSync(app);
  // React and its types come from the registry, as they would in a real app
  const react = { react: "^19.3.0", "react-dom": "^19.3.0" };
  const reactTypes = { "@types/react": "^19.3.0", "@types/react-dom": "^19.3.0" };
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "rayfold-smoke", private: true, type: "module", dependencies: { ...deps, ...react }, devDependencies: reactTypes, overrides: deps }, null, 2));
  sh("npm install --no-audit --no-fund --loglevel=error");

  step("type-check the example as a Node project (skipLibCheck off) and run it with plain Node");
  writeFileSync(join(app, "example.ts"), EXAMPLE);
  writeFileSync(join(app, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", strict: true, skipLibCheck: false, outDir: "out", types: ["node"], typeRoots: [join(ROOT, "node_modules", "@types")] },
    files: ["example.ts"],
  }, null, 2));
  sh(`node "${tsc}" -p tsconfig.json`);
  const out = sh("node out/example.js");
  if (!out.includes("example ok")) throw new Error(`example did not finish:\n${out}`);

  step("type-check browser code without Node types (skipLibCheck off)");
  writeFileSync(join(app, "browser.ts"), BROWSER);
  writeFileSync(join(app, "tsconfig.browser.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", lib: ["ES2022", "DOM"], module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: false, noEmit: true, types: [] },
    files: ["browser.ts"],
  }, null, 2));
  sh(`node "${tsc}" -p tsconfig.browser.json`);

  step("bundle the browser code with esbuild (platform browser)");
  const bundle = esbuild.buildSync({ entryPoints: [join(app, "browser.ts")], bundle: true, platform: "browser", format: "esm", write: false, absWorkingDir: app, logLevel: "silent" });
  const js = bundle.outputFiles[0].text;
  if (/["']node:/.test(js)) throw new Error("the browser bundle refers to a node: module");
  console.log(`  ${Math.round(js.length / 1024)} KB unminified`);

  step("run the rayfold binary");
  writeFileSync(join(app, "schema.rayfold"), SCHEMA);
  sh("npx rayfold check schema.rayfold");
  const types = sh("npx rayfold gen ts schema.rayfold");
  if (!/Book/.test(types)) throw new Error(`rayfold gen ts printed no Book type:\n${types}`);

  ok = true;
  console.log("smoke test passed");
} catch (e) {
  console.error(`smoke test FAILED: ${e.stderr || e.stdout || e.message}`);
  console.error(`work folder kept for inspection: ${work}`);
  process.exitCode = 1;
} finally {
  if (ok && !process.argv.includes("--keep")) rmSync(work, { recursive: true, force: true });
}
