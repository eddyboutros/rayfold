#!/usr/bin/env node
/**
 * Builds and tests the JVM examples the documentation site quotes, so every snippet it imports from them (the `<<<`
 * regions) is code that compiles and passes its tests. Kotlin and Java blocks written inline in a page are not built
 * here. Publishes the runtime to the local Maven repository first: examples/java and examples/spring-boot
 * resolve dev.rayfold artifacts from there, while examples/kotlin builds against kotlin/ directly (a composite build).
 * Prints one line per step and stops at the first failure, with that step's output.
 *
 *   node scripts/examples-jvm.mjs
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WINDOWS = process.platform === "win32";

const steps = [
  { name: "publish the runtime to the local Maven repository", dir: "kotlin", tool: "gradlew", args: ["--no-daemon", "-q", "publishToMavenLocal"] },
  { name: "examples/kotlin: build and test", dir: "examples/kotlin", tool: "gradlew", args: ["--no-daemon", "build"] },
  { name: "examples/java: build and test", dir: "examples/java", tool: "mvnw", args: ["-B", "-ntp", "verify"] },
  { name: "examples/spring-boot: build and test", dir: "examples/spring-boot", tool: "mvnw", args: ["-B", "-ntp", "verify"] },
];

/**
 * Runs a project's own wrapper: gradlew.bat or mvnw.cmd on Windows, which Node starts only through a shell, and the
 * POSIX script through sh elsewhere, so a checkout that lost the executable bit still builds.
 */
function runWrapper({ dir, tool, args }) {
  const cwd = join(ROOT, dir);
  const options = { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] };
  if (WINDOWS) {
    const script = join(cwd, tool === "gradlew" ? "gradlew.bat" : "mvnw.cmd");
    return spawnSync(`"${script}" ${args.join(" ")}`, { ...options, shell: true });
  }
  return spawnSync("sh", [join(cwd, tool), ...args], options);
}

for (const step of steps) {
  const started = Date.now();
  const result = runWrapper(step);
  const took = `${Math.round((Date.now() - started) / 1000)}s`;
  if (result.status !== 0) {
    console.error(`FAILED ${step.name} (${took})`);
    if (result.error) console.error(result.error.message);
    console.error([result.stdout, result.stderr].filter(Boolean).join("\n"));
    process.exit(1);
  }
  console.log(`ok ${step.name} (${took})`);
}
