/**
 * Every problem type either runtime can put in a response has a page on the site, because the problem's `type` is
 * a link people will follow.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HTTP_STATUS, PROBLEM_TYPE_BASE as TS_BASE, PROTOCOL_CODES } from "@rayfold/server";
import { describe, expect, it } from "vitest";
import { ERROR_TYPES, PROBLEM_TYPE_BASE, errorPage } from "./errors.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const files = (dir: string, ext: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name), ext) : e.name.endsWith(ext) && !e.name.includes(".test.") ? [join(dir, e.name)] : []));

const documented = new Map(ERROR_TYPES.map((e) => [e.type, e]));

describe("error pages", () => {
  it("cover every protocol code and domain, with the status the runtime sends", () => {
    for (const code of [...PROTOCOL_CODES, "domain" as const]) {
      expect(documented.get(code), code).toBeDefined();
      expect(documented.get(code)?.status, code).toBe(HTTP_STATUS[code] ?? 500);
    }
  });

  it("cover every extra problem type the TypeScript and Kotlin transports refuse with", () => {
    const ts = files("packages/server/src", ".ts").flatMap((f) => [...read(f).matchAll(/refuse(?:Body)?\([^;]*?,\s*"([a-z_]+)"\)/g)].map((m) => m[1]!));
    const kotlin = files("kotlin/rayfold-core/src/main/kotlin", ".kt").flatMap((f) => [...read(f).matchAll(/(?:refuse|HttpProblem)\([^\n]*"([a-z_]+)"\s*\)/g)].map((m) => m[1]!));
    const extra = new Set([...ts, ...kotlin]);
    expect([...extra].sort()).toEqual(expect.arrayContaining(["payload_too_large", "unsupported_media_type"]));
    for (const type of extra) expect(documented.has(type), type).toBe(true);
  });

  it("point at the same base URI the runtimes use", () => {
    expect(PROBLEM_TYPE_BASE).toBe(TS_BASE);
    expect(read("kotlin/rayfold-core/src/main/kotlin/dev/rayfold/core/Guard.kt")).toContain(`const val PROBLEM_TYPE_BASE = "${PROBLEM_TYPE_BASE}"`);
  });

  it("render each page with its type, its status and a problem document linking back to it", () => {
    const page = errorPage(documented.get("payload_too_large")!);
    expect(page).toContain("# Payload too large");
    expect(page).toContain("HTTP 413");
    expect(page).toContain(`"type": "${PROBLEM_TYPE_BASE}payload_too_large"`);
    expect(page).toContain(`"code": "resource_exhausted"`);
    expect(page).not.toMatch(/[—–“”…·]/);
  });
});
