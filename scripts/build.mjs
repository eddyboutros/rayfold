#!/usr/bin/env node
/**
 * Builds the npm packages. Each one gets a self-contained dist/ folder: compiled ESM, .d.ts files, a publish-ready
 * package.json (sibling "*" versions pinned, exports pointing at compiled files, no private flag), README, LICENSE
 * and NOTICE. Publish from those folders with scripts/publish.mjs, never from the source folders.
 *
 *   node scripts/build.mjs              every package, in dependency order
 *   node scripts/build.mjs schema rb    only these (their dependencies must be built already)
 */
import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGES } from "./packages.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
// through package.json: TypeScript 7 no longer exports bin/tsc as a subpath, and every version exports package.json
const tsPackage = createRequire(import.meta.url).resolve("typescript/package.json");
const tsc = join(dirname(tsPackage), readJson(tsPackage).bin.tsc);

function* files(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else yield p;
  }
}

/** Relative `.ts` specifiers left in declaration files become `.js`, which is what sits next to them. */
const TS_SPECIFIER = /((?:from|import)\s*\(?\s*["'])(\.{1,2}\/[^"']+?)\.ts(["'])/g;
function fixDeclarations(path) {
  const s = readFileSync(path, "utf8");
  const t = s.replace(TS_SPECIFIER, "$1$2.js$3");
  if (t !== s) writeFileSync(path, t);
}

/** "./src/protocol.ts" -> "./protocol": dist mirrors src. */
const distBase = (srcPath) => "./" + srcPath.replace(/^\.\/src\//, "").replace(/\.ts$/, "");

export function manifest(pkg) {
  const src = readJson(join(ROOT, pkg.dir, "package.json"));
  const root = readJson(join(ROOT, "package.json"));
  const versions = Object.fromEntries(PACKAGES.map((p) => {
    const j = readJson(join(ROOT, p.dir, "package.json"));
    return [j.name, j.version];
  }));
  const pin = (deps) =>
    Object.fromEntries(Object.entries(deps).map(([name, range]) => {
      if (range !== "*") return [name, range];
      const v = versions[name];
      if (!v) throw new Error(`${src.name} depends on ${name}, which is not a published package`);
      return [name, `^${v}`];
    }));
  const compiled = src.exports && Object.fromEntries(Object.entries(src.exports).map(([key, path]) => {
    const b = distBase(path);
    return [key, { types: `${b}.d.ts`, default: `${b}.js` }];
  }));
  const exports = compiled && { ...compiled, ...pkg.exports };
  const out = {
    name: src.name,
    version: src.version,
    description: src.description,
    keywords: src.keywords,
    license: src.license,
    author: root.author,
    homepage: root.homepage,
    bugs: root.bugs,
    repository: root.repository ? { ...root.repository, directory: pkg.dir } : undefined,
    type: "module",
    sideEffects: src.sideEffects,
    engines: src.engines,
    main: exports?.["."]?.default,
    types: exports?.["."]?.types,
    exports,
    bin: pkg.bin,
    dependencies: src.dependencies && Object.keys(src.dependencies).length ? pin(src.dependencies) : undefined,
    peerDependencies: src.peerDependencies && pin(src.peerDependencies),
    peerDependenciesMeta: src.peerDependenciesMeta,
    publishConfig: { access: "public" },
  };
  return JSON.parse(JSON.stringify(out)); // drops the undefined fields
}

function build(pkg) {
  const dir = join(ROOT, pkg.dir);
  const dist = join(dir, "dist");
  rmSync(dist, { recursive: true, force: true });
  execFileSync(process.execPath, [tsc, "-p", join(dir, "tsconfig.build.json")], { stdio: "inherit" });
  for (const f of files(dist)) if (f.endsWith(".d.ts")) fixDeclarations(f);
  for (const c of pkg.copy ?? []) cpSync(join(dir, c), join(dist, c), { recursive: true });
  cpSync(join(dir, pkg.readme ?? "README.md"), join(dist, "README.md"));
  for (const f of ["LICENSE", "NOTICE"]) cpSync(join(ROOT, f), join(dist, f));
  writeFileSync(join(dist, "package.json"), JSON.stringify(manifest(pkg), null, 2) + "\n");
  console.log(`built ${pkg.dir}/dist`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const wanted = process.argv.slice(2);
  const list = wanted.length ? PACKAGES.filter((p) => wanted.includes(basename(p.dir))) : PACKAGES;
  if (list.length !== (wanted.length || PACKAGES.length)) throw new Error(`unknown package in: ${wanted.join(" ")}`);
  for (const p of list) build(p);
}
