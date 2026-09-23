import { afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bounded } from "../../../e2e/wait.ts";

const work = mkdtempSync(join(tmpdir(), "rayfold-check-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const main = fileURLToPath(new URL("./main.ts", import.meta.url));
// by URL, because the child runs in `work`, which has no node_modules to find `tsx` in
const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

/** The CLI run from `work`, so no rayfold.lock.json of the repository's is picked up; a hung run fails, not hangs. */
async function rayfold(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", tsx, main, ...args], { cwd: work, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const closed = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
  try {
    return { status: await bounded(closed, `rayfold ${args.join(" ")} exits`, 15_000), stdout, stderr };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await bounded(closed, `rayfold ${args.join(" ")} is gone`);
    }
  }
}

writeFileSync(
  join(work, "schema.rayfold"),
  ["entity Book {", "  id: ID", "  title: String", "  reviews(page: PageArgs = { first: 10 }): Page<Review>", "}", "entity Review { id: ID rating: Int }", "query book(id: ID): Book?", ""].join("\n"),
);

const module = (name: string, source: string): string => {
  writeFileSync(join(work, name), source);
  return name;
};

const COVERED = "OK: the resolvers cover all 1 operation and every field that takes arguments\n";

describe("rayfold check --resolvers", { timeout: 60_000 }, () => {
  it("says so when the resolvers cover the schema", async () => {
    const resolvers = module("covered.mjs", "export const resolvers = { Query: { book: () => null }, Book: { reviews: (books) => books.map(() => null) } };\n");
    expect(await rayfold(["check", "schema.rayfold", "--resolvers", resolvers])).toEqual({ status: 0, stdout: COVERED, stderr: "" });
  });

  it("points at the operation nobody wired, and fails", async () => {
    const resolvers = module("no-op.mjs", "export const resolvers = { Book: { reviews: (books) => books.map(() => null) } };\n");
    expect(await rayfold(["check", "schema.rayfold", "--resolvers", resolvers])).toEqual({
      status: 1,
      stdout: [
        "error    missing-resolver  book(): No query resolver: every call fails with unimplemented. Add Query.book",
        " --> schema.rayfold:7:7",
        "  |",
        "7 | query book(id: ID): Book?",
        "  |       ^^^^",
        "",
        "",
      ].join("\n"),
      stderr: "FAILED: 1 operation or field the resolvers do not cover\n",
    });
  });

  it("points at the field that takes arguments and has no loader", async () => {
    const resolvers = module("no-loader.mjs", "export const resolvers = { Query: { book: () => null } };\n");
    expect(await rayfold(["check", "schema.rayfold", "--resolvers", resolvers])).toEqual({
      status: 1,
      stdout: [
        "error    missing-loader  Book.reviews: The field takes arguments, so it needs a loader: a shape asking for it fails with unimplemented unless the op's resolver already returns it",
        " --> schema.rayfold:4:3",
        "  |",
        "4 |   reviews(page: PageArgs = { first: 10 }): Page<Review>",
        "  |   ^^^^^^^",
        "",
        "",
      ].join("\n"),
      stderr: "FAILED: 1 operation or field the resolvers do not cover\n",
    });
  });

  it("warns about a resolver the schema has no place for, without failing the build", async () => {
    const resolvers = module(
      "renamed.mjs",
      "export const resolvers = { Query: { book: () => null, bookById: () => null }, Book: { reviews: (books) => books.map(() => null) } };\n",
    );
    expect(await rayfold(["check", "schema.rayfold", "--resolvers", resolvers])).toEqual({
      status: 0,
      stdout: "warning  unknown-resolver  bookById(): Query.bookById is wired, but the schema has no such operation\n\n" + COVERED,
      stderr: "",
    });
  });

  it("takes a factory, and refuses a module that offers nothing", async () => {
    const factory = module("factory.mjs", "export default function make() { return { Query: { book: () => null }, Book: { reviews: (b) => b.map(() => null) } }; }\n");
    expect(await rayfold(["check", "schema.rayfold", "--resolvers", factory])).toEqual({ status: 0, stdout: COVERED, stderr: "" });

    const empty = module("empty.mjs", "export const notResolvers = 1;\n");
    expect(await rayfold(["check", "schema.rayfold", "--resolvers", empty])).toEqual({
      status: 1,
      stdout: "",
      stderr: "empty.mjs: no resolvers found: export `resolvers`, a default export, or a function that returns them\n",
    });
  });
});
