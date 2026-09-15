#!/usr/bin/env node
/**
 * Publishes the packages to npm from their dist folders, in dependency order.
 *
 *   node scripts/publish.mjs --dry-run      build, then list exactly what each package would contain
 *   node scripts/publish.mjs                build, then publish (needs `npm login`, or a token in CI)
 *   node scripts/publish.mjs --provenance   the same from GitHub Actions, with a signed provenance statement
 *   --tag next                              publish under a dist-tag other than "latest"
 *   --no-build                              publish the dist folders as they are
 *
 * Refuses when the packages disagree on the version, when that version is already on npm, or (for a real publish)
 * when the root package.json has no "repository": npm provenance needs it and the npm pages link to it.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGES } from "./packages.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const provenance = args.includes("--provenance");
const tagAt = args.indexOf("--tag");
const tag = tagAt >= 0 ? args[tagAt + 1] : undefined;

function fail(message) {
  console.error(`publish: ${message}`);
  process.exit(1);
}

function onNpm(name, version) {
  try {
    return execSync(`npm view ${name}@${version} version`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === version;
  } catch {
    return false; // E404: the package or this version is not on npm
  }
}

if (!args.includes("--no-build")) execSync("node scripts/build.mjs", { cwd: ROOT, stdio: "inherit" });

const packages = PACKAGES.map((p) => ({ dist: join(ROOT, p.dir, "dist"), manifest: readJson(join(ROOT, p.dir, "dist", "package.json")) }));
const versions = new Set(packages.map((p) => p.manifest.version));
if (versions.size !== 1) fail(`the packages disagree on the version (${[...versions].join(", ")}); run node scripts/set-version.mjs <version>`);
if (!dry && !readJson(join(ROOT, "package.json")).repository) fail('set "repository" in the root package.json first (docs/releasing.md)');
for (const { manifest } of packages) if (onNpm(manifest.name, manifest.version)) fail(`${manifest.name}@${manifest.version} is already on npm; bump the version first`);

const flags = ["--access public", dry ? "--dry-run" : "", provenance ? "--provenance" : "", tag ? `--tag ${tag}` : ""].filter(Boolean).join(" ");
for (const { dist, manifest } of packages) {
  console.log(`\n${dry ? "dry run" : "publishing"}: ${manifest.name}@${manifest.version}`);
  execSync(`npm publish "${dist}" ${flags}`, { stdio: "inherit" });
}
console.log(dry ? "\ndry run finished: nothing was published" : `\npublished ${packages.length} packages`);
