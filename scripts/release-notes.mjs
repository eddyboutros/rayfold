#!/usr/bin/env node
/**
 * Prints one version's section of CHANGELOG.md, for a release's notes.
 *
 * GitHub's own `--generate-notes` lists merged pull requests, and the work here lands as commits on main, so it
 * produced a release page naming three dependabot bumps and none of the release. The changelog is the thing that was
 * written for a reader; this hands it over.
 *
 *   node scripts/release-notes.mjs 0.2.0
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2]?.replace(/^v/, "");
if (!version) {
  console.error("usage: node scripts/release-notes.mjs <version>");
  process.exit(2);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");

// the heading is "## <version> (<date>)"; the section runs to the next "## " or the end
const start = changelog.search(new RegExp(`^## ${version.replace(/\./g, "\\.")}(\\s|$)`, "m"));
if (start < 0) {
  console.error(`CHANGELOG.md has no section for ${version}`);
  process.exit(1);
}
const rest = changelog.slice(start);
const end = rest.indexOf("\n## ", 1);
const body = (end < 0 ? rest : rest.slice(0, end)).replace(/^## .*\n/, "").trim();

const repo = process.env["GITHUB_REPOSITORY"] ?? "eddyboutros/rayfold";
process.stdout.write(`${body}\n\n[CHANGELOG](https://github.com/${repo}/blob/main/CHANGELOG.md) · [which feature came with which version](https://rayfold.dev/versioning#what-each-version-added)\n`);
