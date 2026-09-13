/**
 * The explorer page has one source: packages/explorer/src/index.ts. This copies it into rayfold-core's resources so
 * the JVM serves the same page, byte for byte. A test in packages/explorer fails if the two ever drift.
 *
 *   node scripts/sync-explorer.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "packages/explorer/src/index.ts");
const TARGET = join(ROOT, "kotlin/rayfold-core/src/main/resources/dev/rayfold/core/explorer.html");

const src = readFileSync(SOURCE, "utf8");
const open = src.indexOf("String.raw`");
const close = src.lastIndexOf("`");
if (open < 0 || close <= open) throw new Error(`no page template in ${SOURCE}`);
const page = src.slice(open + "String.raw`".length, close);

// String.raw still interpolates, so a ${...} in the page would mean the file is not the page
if (page.includes("${")) throw new Error("the page template interpolates; it must be literal to be shared");
if (!page.includes("__RAYFOLD_EXPLORER_CONFIG__")) throw new Error("the page has no configuration placeholder");

mkdirSync(dirname(TARGET), { recursive: true });
writeFileSync(TARGET, page);
console.log(`explorer page: ${page.length} chars -> kotlin/rayfold-core/src/main/resources/dev/rayfold/core/explorer.html`);
