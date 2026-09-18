#!/usr/bin/env node
/**
 * Sets one version on every published npm package and on the Kotlin/Java modules, so a release carries a single
 * number everywhere.
 *
 *   node scripts/set-version.mjs 0.2.0
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGES } from "./packages.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: node scripts/set-version.mjs <major.minor.patch[-prerelease]>");
  process.exit(2);
}

for (const p of PACKAGES) {
  const file = join(ROOT, p.dir, "package.json");
  const json = JSON.parse(readFileSync(file, "utf8"));
  json.version = version;
  writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
  console.log(`${json.name} ${version}`);
}

const gradle = join(ROOT, "kotlin", "gradle.properties");
const text = readFileSync(gradle, "utf8");
if (!/^VERSION_NAME=/m.test(text)) throw new Error(`no VERSION_NAME line in ${gradle}`);
writeFileSync(gradle, text.replace(/^VERSION_NAME=.*$/m, `VERSION_NAME=${version}`));
console.log(`kotlin modules ${version}`);

/**
 * The JVM examples pin the runtime they build against, and `scripts/examples-jvm.mjs` publishes it to the local
 * Maven repository for them. Left behind at the old number they resolve the previous release from Maven Central
 * instead — so they still build, still pass, and stop testing the tree entirely. They are also what the
 * documentation site quotes, so the version a reader copies is this one.
 */
const pins = [
  { file: "examples/java/pom.xml", kind: "pom" },
  { file: "examples/spring-boot/pom.xml", kind: "pom" },
  { file: "examples/kotlin/build.gradle.kts", kind: "gradle" },
];

for (const { file, kind } of pins) {
  const path = join(ROOT, file);
  const before = readFileSync(path, "utf8");
  const after =
    kind === "pom"
      ? // only the <version> of a dev.rayfold dependency; the example's own version is left alone
        before.replace(
          /(<groupId>dev\.rayfold<\/groupId>\s*<artifactId>[^<]+<\/artifactId>\s*<version>)[^<]+(<\/version>)/g,
          `$1${version}$2`,
        )
      : before.replace(/(["']dev\.rayfold:[^:"']+:)[^"']+(["'])/g, `$1${version}$2`);
  if (after === before) throw new Error(`no dev.rayfold version to set in ${file}`);
  writeFileSync(path, after);
  console.log(`${file} ${version}`);
}
