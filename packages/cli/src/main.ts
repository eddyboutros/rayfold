#!/usr/bin/env node
/** rayfold CLI: check | lock | hash | explain | gen | shapes | dev */
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
  loadSchema,
  parseShapeText,
  shapeIdOf,
  validateIR,
  type Change,
  type RayfoldSchemaIR,
} from "@rayfold/schema";
import { estimateCost, defaultShape, pushableFilter, hasPolicy } from "@rayfold/server";
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
  lock <schema.rayfold> [--out rayfold.lock.json]                             record ordinals + hash
  hash <schema.rayfold>                                                   print the schema hash
  explain <schema.rayfold> <op> [--shape "{...}"] [--args '{...}']          plan: cost, depth, loaders per level, policy pushdown
  gen ts|kotlin|java <schema.rayfold> [--out file] [--package pkg] [--class Name]   generate TypeScript types, Kotlin data classes or Java records
  shapes <schema.rayfold> <shape-file>                                    print shape ids for each line
  dev <example-dir> [--port 4400]                                     run a server + playground`);
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
      let loaded;
      try {
        loaded = loadFile(path);
      } catch (e) {
        console.error(String((e as Error).message));
        return 1;
      }
      for (const w of loaded.warnings) console.log(`warning   ${w.at}: ${w.message} [${w.code}]`);
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
      const { playgroundHandler } = await import("./playground.ts");
      const viewer = (req: import("node:http").IncomingMessage) => {
        const a = req.headers.authorization ?? new URL(req.url ?? "/", "http://x").searchParams.get("auth") ?? undefined;
        if (a === "Bearer admin") return { id: "u9", role: "admin" };
        if (a?.startsWith("Bearer ")) return { id: a.slice(7), role: "customer" };
        return null;
      };
      const rayfoldHandler = srv.createHttpHandler(server, { cors: "*", viewer });
      const mcpHandler = srv.createMcpHandler(server, { viewer });
      const { createServer } = await import("node:http");
      const http = createServer((req, res) => {
        void (async () => {
          if ((req.url ?? "/").startsWith("/rayfold")) return rayfoldHandler(req, res);
          if (await mcpHandler(req, res)) return;
          playgroundHandler(req, res);
        })();
      });
      srv.attachWebSocket(http, server, { viewer });
      await new Promise<void>((r) => http.listen(port, r));
      console.log(`Rayfold dev server: http://localhost:${port}/`);
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
