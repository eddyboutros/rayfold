#!/usr/bin/env node
/**
 * `npm audit` for the published dependencies, without failing the build when npm's advisory service is down.
 *
 * `npm audit` exits 1 for two unrelated reasons: it found something, or it could not ask. On 2026-09-19 the second
 * one stopped every push for the length of an npm maintenance window. A vulnerability and an unreachable service
 * are not the same answer, so this tells them apart: findings fail, an outage is retried and then reported as a
 * warning, because the OSV scanner in the same job reads the same lockfile from a different database and still ran.
 *
 *   node scripts/audit.mjs
 */
import { spawnSync } from "node:child_process";

/** Severities at or above the level the job cares about. */
const AT_LEAST_MODERATE = ["moderate", "high", "critical"];

/**
 * What one `npm audit --json` run means.
 *
 * @param {string} stdout
 * @returns {{ outcome: "clean" | "vulnerable" | "unavailable"; detail: string }}
 */
export function readAudit(stdout, stderr = "") {
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    // no JSON at all is not an answer either; treat it the way an outage is treated rather than as "clean", and
    // say what npm actually printed, since "no JSON" on its own has sent me looking in the wrong place once already
    const said = stderr.trim().split("\n").at(-1) ?? "";
    return { outcome: "unavailable", detail: said ? `npm audit printed no JSON: ${said}` : "npm audit printed no JSON" };
  }
  if (report && typeof report === "object" && ("error" in report || "message" in report)) {
    // npm says this two ways depending on the version: a `message` at the top, or an `error` that may be an object
    // with nothing in it. Take whichever actually carries words.
    const parts = [report.message, typeof report.error === "string" ? report.error : report.error?.detail || report.error?.summary];
    const detail = parts.find((p) => typeof p === "string" && p.trim()) ?? JSON.stringify(report.error ?? report.message);
    return { outcome: "unavailable", detail };
  }
  const counts = report?.metadata?.vulnerabilities;
  if (!counts || typeof counts !== "object") return { outcome: "unavailable", detail: "npm audit reported no counts" };
  const found = AT_LEAST_MODERATE.map((level) => [level, Number(counts[level] ?? 0)]).filter(([, n]) => n > 0);
  if (!found.length) return { outcome: "clean", detail: "nothing at moderate or above" };
  return { outcome: "vulnerable", detail: found.map(([level, n]) => `${n} ${level}`).join(", ") };
}

const ATTEMPTS = 3;

async function main() {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    // a shell on Windows, where npm is a .cmd; the arguments are fixed literals, so there is nothing to escape
    const run = spawnSync("npm", ["audit", "--omit=dev", "--audit-level=moderate", "--json"], { encoding: "utf8", shell: process.platform === "win32" });
    const { outcome, detail } = readAudit(run.stdout ?? "", `${run.stderr ?? ""}${run.error ? `\n${run.error.message}` : ""}`);
    if (outcome === "clean") {
      console.log(`npm audit: ${detail}`);
      return 0;
    }
    if (outcome === "vulnerable") {
      console.error(`npm audit found ${detail} in what the published packages depend on`);
      console.error(run.stdout);
      return 1;
    }
    console.error(`npm audit could not ask (attempt ${attempt} of ${ATTEMPTS}): ${detail}`);
    if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, attempt * 5_000));
  }
  // not a finding, and not something a commit can fix: the OSV scanner in this job is the check that remains
  console.error("npm audit is unavailable; the OSV scanner in this job reads the same lockfile and still runs");
  return 0;
}

if (import.meta.filename === process.argv[1]) process.exit(await main());
