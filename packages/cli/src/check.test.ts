import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const work = mkdtempSync(join(tmpdir(), "rayfold-check-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const main = fileURLToPath(new URL("./main.ts", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));

function rayfold(args: string[]): { stdout: string; stderr: string; status: number } {
  const run = spawnSync(process.execPath, ["--import", "tsx", main, ...args], { cwd: root, encoding: "utf8" });
  return { stdout: run.stdout ?? "", stderr: run.stderr ?? "", status: run.status ?? 1 };
}

const SCHEMA = join(work, "schema.rayfold");
writeFileSync(
  SCHEMA,
  ["entity Book {", "  id: ID", "  title: String", "  reviews(page: PageArgs = { first: 10 }): Page<Review>", "}", "entity Review { id: ID rating: Int }", "query book(id: ID): Book?", ""].join("\n"),
);

const module = (name: string, source: string): string => {
  const path = join(work, name);
  writeFileSync(path, source);
  return path;
};

describe("rayfold check --resolvers", () => {
  it("says so when the resolvers cover the schema", () => {
    const resolvers = module("covered.mjs", "export const resolvers = { Query: { book: () => null }, Book: { reviews: (books) => books.map(() => null) } };\n");
    const run = rayfold(["check", SCHEMA, "--resolvers", resolvers]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("OK: the resolvers cover all 1 operation and every field that takes arguments");
  });

  it("points at the operation nobody wired, and fails", () => {
    const resolvers = module("no-op.mjs", "export const resolvers = { Book: { reviews: (books) => books.map(() => null) } };\n");
    const run = rayfold(["check", SCHEMA, "--resolvers", resolvers]);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("missing-resolver  book()");
    expect(run.stdout).toContain("query book(id: ID): Book?");
    expect(run.stdout).toContain("--> ");
    expect(run.stderr).toContain("FAILED: 1 operation");
  });

  it("points at the field that takes arguments and has no loader", () => {
    const resolvers = module("no-loader.mjs", "export const resolvers = { Query: { book: () => null } };\n");
    const run = rayfold(["check", SCHEMA, "--resolvers", resolvers]);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("missing-loader  Book.reviews");
    expect(run.stdout).toContain("reviews(page: PageArgs = { first: 10 }): Page<Review>");
  });

  it("warns about a resolver the schema has no place for, without failing the build", () => {
    const resolvers = module(
      "renamed.mjs",
      "export const resolvers = { Query: { book: () => null, bookById: () => null }, Book: { reviews: (books) => books.map(() => null) } };\n",
    );
    const run = rayfold(["check", SCHEMA, "--resolvers", resolvers]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("unknown-resolver  bookById()");
    expect(run.stdout).toContain("OK: the resolvers cover all 1 operation");
  });

  it("takes a factory, and refuses a module that offers nothing", () => {
    const factory = module("factory.mjs", "export default function make() { return { Query: { book: () => null }, Book: { reviews: (b) => b.map(() => null) } }; }\n");
    expect(rayfold(["check", SCHEMA, "--resolvers", factory]).status).toBe(0);

    const empty = module("empty.mjs", "export const notResolvers = 1;\n");
    const run = rayfold(["check", SCHEMA, "--resolvers", empty]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("no resolvers found");
  });
});
