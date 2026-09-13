#!/usr/bin/env node
/** rayfold CLI: check | lock | hash | explain | gen | shapes | import | mock | lsp | dev */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonicalShape,
  diffSchemas,
  generateJava,
  generateKotlin,
  generateTypeScript,
  isBreaking,
  RayfoldSchemaError,
  RayfoldSyntaxError,
  loadSchema,
  parseSchemaText,
  parseShapeText,
  printSchemaText,
  shapeIdOf,
  validateIR,
  type Change,
  type RayfoldSchemaIR,
} from "@rayfold/schema";
import { checkWiring, estimateCost, defaultShape, pushableFilter, hasPolicy, type Resolvers, type UsageEntry } from "@rayfold/server";
import { annotation, baseName, fieldsOf, typeRefToString, type TypeRef, exprToString } from "@rayfold/schema";

interface Lock {
  rayfold: "0.1";
  hash: string;
  ir: RayfoldSchemaIR;
  lockedAt: string;
}

function usage(): never {
  console.error(`rayfold <command>

  check <schema.rayfold> [--against <old.rayfold|rayfold.lock.json>] [--strict]   validate; report breaking changes
  check <schema.rayfold> --unused <usage.json> [--since 30d]              members no client asked for
  check <schema.rayfold> --resolvers <module>                             do the resolvers cover the schema?
  lock <schema.rayfold> [--out rayfold.lock.json]                             record ordinals + hash
  hash <schema.rayfold>                                                   print the schema hash
  explain <schema.rayfold> <op> [--shape "{...}"] [--args '{...}']          plan: cost, depth, loaders per level, policy pushdown
  gen ts|kotlin|java <schema.rayfold> [--out file] [--package pkg] [--class Name]   generate TypeScript types, Kotlin data classes or Java records
  shapes <schema.rayfold> <shape-file>                                    print shape ids for each line
  import openapi|graphql <file> [--out schema.rayfold]                a schema from an OpenAPI document or a GraphQL SDL
  mock <schema.rayfold> [--port 4500]                                 serve the schema with made-up data, and the explorer
  lsp                                                                 language server for .rayfold, over stdio
  dev <example-dir> [--port 4400]                                     run a server + explorer`);
  process.exit(2);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function loadFile(path: string): ReturnType<typeof loadSchema> {
  const text = readFileSync(resolve(path), "utf8");
  return loadSchema(text);
}

function loadOld(path: string): RayfoldSchemaIR {
  if (path.endsWith(".json")) return (JSON.parse(readFileSync(resolve(path), "utf8")) as Lock).ir;
  return loadFile(path).ir;
}

/** `30d`, `12h`, `90m`, `45s` as milliseconds. */
function windowOf(text: string): number {
  const m = /^(\d+)([dhms])$/.exec(text.trim());
  if (!m) throw new Error(`--since expects a window such as 30d, 12h or 90m, not ${text}`);
  return Number(m[1]) * { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 }[m[2] as "d" | "h" | "m" | "s"];
}

/**
 * Members no client asked for inside the window, and the clients still asking for members already deprecated.
 * The snapshot comes from a running server, so "unused" means "no traffic was seen", never "unreachable".
 */
function printUnused(ir: RayfoldSchemaIR, entries: UsageEntry[], windowMs: number, now: number): void {
  const fresh = entries.filter((e) => Date.parse(e.lastSeen) >= now - windowMs);
  const usedOps = new Set(fresh.filter((e) => !e.path).map((e) => e.op));
  const usedPaths = new Set(fresh.filter((e) => e.path).map((e) => e.path));
  const clientsOf = (path: string) => [...new Set(fresh.filter((e) => e.path === path).map((e) => e.client || "(unnamed)"))].sort();

  let unused = 0;
  for (const op of Object.values(ir.ops)) {
    if (usedOps.has(op.name)) continue;
    unused++;
    console.log(`unused      ${op.name}(): no traffic`);
  }
  for (const t of Object.values(ir.types)) {
    if (t.builtin || !("fields" in t) || t.kind === "input" || t.kind === "error" || t.kind === "event") continue;
    for (const f of t.fields) {
      const path = `${t.name}.${f.name}`;
      if (usedPaths.has(path)) {
        if (annotation(f, "deprecated")) console.log(`still used  ${path}: ${clientsOf(path).join(", ")}`);
        continue;
      }
      unused++;
      console.log(`unused      ${path}: no traffic`);
    }
  }
  const clients = new Set(fresh.map((e) => e.client || "(unnamed)"));
  const stale = entries.length - fresh.length;
  console.log(`\n${unused} member${unused === 1 ? "" : "s"} with no traffic from ${clients.size} client${clients.size === 1 ? "" : "s"}; ${stale} record${stale === 1 ? "" : "s"} older than the window.`);
}

/**
 * The resolvers a module offers: an object named `resolvers`, the default export, or a factory that makes one. A
 * factory is called with no arguments, which is enough to read its keys; whatever it needs belongs inside a handler.
 */
function resolversFrom(module: Record<string, unknown>): Resolvers {
  const candidates = [module["resolvers"], module["default"], ...Object.entries(module).filter(([k]) => /resolvers$/i.test(k)).map(([, v]) => v)];
  for (const candidate of candidates) {
    if (typeof candidate === "function") return (candidate as () => Resolvers)();
    if (candidate && typeof candidate === "object") return candidate as Resolvers;
  }
  throw new Error("no resolvers found: export `resolvers`, a default export, or a function that returns them");
}

function printChanges(changes: Change[]): void {
  const order = { breaking: 0, warning: 1, compatible: 2 };
  for (const c of [...changes].sort((a, b) => order[a.level] - order[b.level])) {
    const tag = c.level === "breaking" ? "BREAKING" : c.level === "warning" ? "warning " : "ok      ";
    console.log(`${tag}  ${c.at}: ${c.message} [${c.code}]`);
  }
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "check": {
      const path = rest[0];
      if (!path) usage();
      const source = readFileSync(resolve(path), "utf8");
      const { findingsFor, renderFinding, syntaxFinding } = await import("./report.ts");
      let loaded;
      try {
        loaded = loadSchema(source);
      } catch (e) {
        if (e instanceof RayfoldSchemaError) {
          // the text parsed, so there is an IR to read the likely fix out of
          let ir: RayfoldSchemaIR | undefined;
          try {
            ir = parseSchemaText(source);
          } catch {
            ir = undefined;
          }
          for (const finding of findingsFor(source, e.diagnostics)) {
            console.error(renderFinding(path, source, finding, ir));
            console.error("");
          }
        } else if (e instanceof RayfoldSyntaxError) {
          console.error(renderFinding(path, source, syntaxFinding(e)));
        } else console.error(String((e as Error).message));
        return 1;
      }
      for (const finding of findingsFor(source, loaded.warnings)) {
        console.log(renderFinding(path, source, finding, loaded.ir));
        console.log("");
      }
      const wiring = flag(rest, "--resolvers");
      if (wiring) {
        let resolvers: Resolvers;
        try {
          resolvers = resolversFrom((await import(pathToFileURL(resolve(wiring)).href)) as Record<string, unknown>);
        } catch (e) {
          console.error(`${wiring}: ${String((e as Error).message)}`);
          return 1;
        }
        const findings = findingsFor(source, checkWiring(loaded.ir, resolvers));
        for (const finding of findings) {
          console.log(renderFinding(path, source, finding, loaded.ir));
          console.log("");
        }
        const errors = findings.filter((f) => f.severity === "error").length;
        if (errors) {
          console.error(`FAILED: ${errors} operation${errors === 1 ? "" : "s"} or field${errors === 1 ? "" : "s"} the resolvers do not cover`);
          return 1;
        }
        const ops = Object.keys(loaded.ir.ops).length;
        console.log(`OK: the resolvers cover all ${ops} operation${ops === 1 ? "" : "s"} and every field that takes arguments`);
        return 0;
      }
      const unused = flag(rest, "--unused");
      if (unused) {
        let entries: UsageEntry[];
        try {
          entries = JSON.parse(readFileSync(resolve(unused), "utf8")) as UsageEntry[];
          if (!Array.isArray(entries)) throw new Error("expected a list of usage records");
        } catch (e) {
          console.error(`${unused}: ${String((e as Error).message)}`);
          return 1;
        }
        try {
          printUnused(loaded.ir, entries, windowOf(flag(rest, "--since") ?? "30d"), Date.now());
        } catch (e) {
          console.error(String((e as Error).message));
          return 2;
        }
        return 0;
      }
      const against = flag(rest, "--against") ?? (existsSync("rayfold.lock.json") ? "rayfold.lock.json" : undefined);
      if (against) {
        const changes = diffSchemas(loadOld(against), loaded.ir);
        printChanges(changes);
        const strict = rest.includes("--strict");
        if (isBreaking(changes) || (strict && changes.some((c) => c.level === "warning"))) {
          console.log(`\n${loaded.ir ? "" : ""}FAILED: breaking changes against ${against}`);
          return 1;
        }
        console.log(`\nOK: compatible with ${against} (${changes.length} change${changes.length === 1 ? "" : "s"})`);
      } else console.log(`OK: ${path} is valid (hash ${loaded.hash.slice(0, 12)})`);
      return 0;
    }
    case "lock": {
      const path = rest[0];
      if (!path) usage();
      const loaded = loadFile(path);
      const out = flag(rest, "--out") ?? "rayfold.lock.json";
      const lock: Lock = { rayfold: "0.1", hash: loaded.hash, ir: loaded.ir, lockedAt: new Date().toISOString() };
      writeFileSync(out, JSON.stringify(lock, null, 2) + "\n");
      console.log(`wrote ${out} (hash ${loaded.hash.slice(0, 12)})`);
      return 0;
    }
    case "hash": {
      const path = rest[0];
      if (!path) usage();
      console.log(loadFile(path).hash);
      return 0;
    }
    case "explain": {
      const [path, opName] = rest;
      if (!path || !opName) usage();
      const { ir } = loadFile(path);
      const op = ir.ops[opName];
      if (!op) {
        console.error(`Unknown operation ${opName}`);
        return 1;
      }
      const shapeText = flag(rest, "--shape");
      const args = JSON.parse(flag(rest, "--args") ?? "{}") as Record<string, unknown>;
      const shape = shapeText ? parseShapeText(shapeText) : defaultShape(ir, op.returns);
      const est = estimateCost(ir, op, args, shape);
      console.log(`${op.kind} ${op.name}(): cost ${est.cost}, depth ${est.depth}, ${est.fields} field${est.fields === 1 ? "" : "s"}`);
      console.log(`shape: ${canonicalShape(shape, (t, v) => ir.views[`${t}.${v}`])}`);
      console.log(`policy: ${hasPolicy(op.annotations, op.kind === "command" ? "write" : "read") ? "op-level policy" : "none"}`);
      console.log("plan:");
      const walk = (t: TypeRef, s: typeof shape, level: number): void => {
        const name = baseName(t);
        const def = ir.types[name];
        if (!def || !("fields" in def)) return;
        const fs = fieldsOf(ir, t) ?? [];
        const pf = pushableFilter(def.annotations);
        const pol = hasPolicy(def.annotations, "read") ? (pf ? ` [policy pushed down: ${exprToString(pf)}]` : " [policy post-filtered]") : "";
        console.log(`${"  ".repeat(level)}level ${level}: ${typeRefToString(t)}${pol}`);
        for (const it of s.items) {
          if (it.kind !== "field") continue;
          const f = fs.find((x) => x.name === it.name);
          if (!f) continue;
          const scalar = ir.types[baseName(f.type)]?.kind === "scalar" || ir.types[baseName(f.type)]?.kind === "enum";
          const load = annotation(f, "load");
          const builtin = ir.types[name]?.builtin;
          const mode = scalar || builtin ? "property" : load && (load.args["value"] as { $ident?: string })?.$ident === "single" ? "loader (single, per parent)" : "loader (batch, 1 call)";
          const fp = f.annotations.some((a) => a.name === "allow" || a.name === "deny") ? " [field policy]" : "";
          const lazy = annotation(f, "lazy") && !it.eager ? " [deferred]" : "";
          console.log(`${"  ".repeat(level + 1)}${it.alias ?? it.name}: ${mode}${fp}${lazy}`);
          if (!scalar) walk(f.type, it.shape ?? defaultShape(ir, f.type), level + 1);
        }
      };
      walk(op.returns, shape, 0);
      return 0;
    }
    case "gen": {
      const [lang, path] = rest;
      if (!path) usage();
      const { ir } = loadFile(path);
      let text: string;
      if (lang === "ts") text = generateTypeScript(ir);
      else if (lang === "kotlin") text = generateKotlin(ir, { pkg: flag(rest, "--package") ?? "dev.rayfold.generated" });
      else if (lang === "java") text = generateJava(ir, { pkg: flag(rest, "--package") ?? "dev.rayfold.generated", className: flag(rest, "--class") ?? "RayfoldSchema" });
      else {
        console.error(`Unsupported target ${lang} (ts, kotlin, java)`);
        return 1;
      }
      const out = flag(rest, "--out");
      if (out) {
        writeFileSync(out, text);
        console.log(`wrote ${out}`);
      } else process.stdout.write(text);
      return 0;
    }
    case "shapes": {
      const [path, file] = rest;
      if (!path || !file) usage();
      const { ir } = loadFile(path);
      const views = (t: string, v: string) => ir.views[`${t}.${v}`];
      const lines = readFileSync(resolve(file), "utf8").split(/\r?\n/).filter((l) => l.trim());
      const map: Record<string, string> = {};
      for (const l of lines) {
        const canon = canonicalShape(parseShapeText(l), views);
        map[shapeIdOf(canon)] = canon;
      }
      console.log(JSON.stringify(map, null, 2));
      return 0;
    }
    case "import": {
      const [source, path] = rest;
      if (!source || !path) usage();
      let imported;
      try {
        const text = readFileSync(resolve(path), "utf8");
        if (source === "openapi") {
          const { irFromOpenApi } = await import("./import-openapi.ts");
          imported = irFromOpenApi(JSON.parse(text) as Record<string, unknown>);
        } else if (source === "graphql") {
          const { irFromGraphql } = await import("./import-graphql.ts");
          imported = await irFromGraphql(text);
        } else {
          console.error(`Unsupported source ${source} (openapi, graphql)`);
          return 1;
        }
      } catch (e) {
        console.error(String((e as Error).message));
        return 1;
      }
      const text = printSchemaText(imported.ir);
      const out = flag(rest, "--out");
      if (out) {
        writeFileSync(out, text);
        console.log(`wrote ${out}`);
      } else process.stdout.write(text);
      // what the source could not say, on stderr, so the schema on stdout stays a schema
      for (const note of imported.notes) console.error(`note      ${note}`);
      return 0;
    }
    case "mock": {
      const path = rest[0];
      if (!path) usage();
      const port = Number(flag(rest, "--port") ?? 4500);
      const { ir, hash } = loadFile(path);
      const { mockResolvers } = await import("./mock.ts");
      const srv = await import("@rayfold/server");
      const { createExplorerHandler } = await import("@rayfold/explorer");
      const server = srv.createRayfoldServer({ schema: ir, resolvers: mockResolvers(ir) });
      // a mock signs you in: it exists to answer, not to refuse
      const handler = srv.createHttpHandler(server, { cors: "*", viewer: () => ({ id: "u1", role: "admin" }) });
      const explorer = createExplorerHandler({ endpoint: "/rayfold", title: "Rayfold mock" });
      const { createServer } = await import("node:http");
      const http = createServer((req, res) => {
        if (explorer(req, res)) return;
        if ((req.url ?? "/").startsWith("/rayfold")) return void handler(req, res);
        res.writeHead(302, { location: "/rayfold/explorer" }).end();
      });
      srv.attachWebSocket(http, server, { viewer: () => ({ id: "u1", role: "admin" }) });
      await new Promise<void>((ready) => http.listen(port, ready));
      console.log(`Rayfold mock of ${path} (schema ${hash.slice(0, 12)})`);
      console.log(`  HTTP      http://localhost:${port}/rayfold`);
      console.log(`  Explorer  http://localhost:${port}/rayfold/explorer`);
      console.log(`  the same call always gives the same answer`);
      await new Promise(() => {});
      return 0;
    }
    case "lsp": {
      const { serveStdio } = await import("@rayfold/lsp");
      // runs until the editor sends `exit` or closes the pipe
      await new Promise<void>((done) => serveStdio(process.stdin, process.stdout, { onExit: done }));
      return 0;
    }
    case "dev": {
      const dir = rest[0];
      if (!dir) usage();
      const port = Number(flag(rest, "--port") ?? 4400);
      const mod = (await import(pathToFileURL(resolve(dir, "src/index.ts")).href)) as { createBookstore?: () => { server: import("@rayfold/server").RayfoldServer } };
      if (!mod.createBookstore) {
        console.error("dev expects an example exporting createBookstore()");
        return 1;
      }
      const srv = await import("@rayfold/server");
      const { server } = mod.createBookstore();
      const { createExplorerHandler } = await import("@rayfold/explorer");
      const viewer = (req: import("node:http").IncomingMessage) => {
        const a = req.headers.authorization ?? new URL(req.url ?? "/", "http://x").searchParams.get("auth") ?? undefined;
        if (a === "Bearer admin") return { id: "u9", role: "admin" };
        if (a?.startsWith("Bearer ")) return { id: a.slice(7), role: "customer" };
        return null;
      };
      const rayfoldHandler = srv.createHttpHandler(server, { cors: "*", viewer });
      const mcpHandler = srv.createMcpHandler(server, { viewer });
      const explorer = createExplorerHandler({ endpoint: "/rayfold", title: "Rayfold dev" });
      const { createServer } = await import("node:http");
      const http = createServer((req, res) => {
        void (async () => {
          if (explorer(req, res)) return; // before the endpoint: the page lives under its path
          if ((req.url ?? "/").startsWith("/rayfold")) return rayfoldHandler(req, res);
          if (await mcpHandler(req, res)) return;
          res.writeHead(302, { location: "/rayfold/explorer" }).end();
        })();
      });
      srv.attachWebSocket(http, server, { viewer });
      await new Promise<void>((r) => http.listen(port, r));
      console.log(`Rayfold dev server: http://localhost:${port}/`);
      console.log(`  Explorer  http://localhost:${port}/rayfold/explorer`);
      console.log(`  HTTP      http://localhost:${port}/rayfold      (POST/QUERY batches, GET /rayfold/{op}, /rayfold/manifest)`);
      console.log(`  WebSocket ws://localhost:${port}/rayfold/ws    (subprotocol rayfold.0.1)`);
      console.log(`  MCP       http://localhost:${port}/mcp      (Streamable HTTP, ${srv.MCP_PROTOCOL_VERSION})`);
      console.log(`  schema    ${server.hash.slice(0, 12)}`);
      await new Promise(() => {});
      return 0;
    }
    default:
      usage();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);

export { validateIR };
