import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadSchema } from "@rayfold/schema";
import { MCP_PROTOCOL_VERSION } from "@rayfold/server";
import { createBookstore } from "../../../examples/bookstore-ts/src/index.ts";
import { bounded } from "../../../e2e/wait.ts";

const main = fileURLToPath(new URL("./main.ts", import.meta.url));
// by URL, because the child runs in a scratch directory that has no node_modules to find `tsx` in
const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
// a cold start compiles main.ts and every package it imports, which on a busy Windows runner takes seconds
const START_MS = 15_000;

interface Proc {
  child: ChildProcessByStdio<null, Readable, Readable>;
  stdout: string;
  stderr: string;
  /** Resolves with the exit code once the process has exited and its output is flushed. */
  closed: Promise<number | null>;
}

const procs = new Set<Proc>();
let work = "";

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "rayfold-cli-"));
});

afterEach(async () => {
  for (const proc of procs) {
    if (proc.child.exitCode === null && proc.child.signalCode === null) proc.child.kill();
    await bounded(proc.closed, `rayfold ${proc.child.spawnargs.slice(3).join(" ")} is gone`);
  }
  procs.clear();
  rmSync(work, { recursive: true, force: true });
});

/** The CLI as a user runs it, from `work`, so `rayfold.lock.json` means the one in there. */
function start(args: string[]): Proc {
  const child = spawn(process.execPath, ["--import", tsx, main, ...args], { cwd: work, stdio: ["ignore", "pipe", "pipe"] });
  const proc: Proc = { child, stdout: "", stderr: "", closed: new Promise((resolve) => child.once("close", (code) => resolve(code))) };
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (proc.stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (proc.stderr += chunk));
  procs.add(proc);
  return proc;
}

async function rayfold(...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const proc = start(args);
  const status = await bounded(proc.closed, `rayfold ${args.join(" ")} exits`, START_MS);
  return { status, stdout: proc.stdout, stderr: proc.stderr };
}

function file(name: string, lines: string[]): string {
  writeFileSync(join(work, name), lines.join("\n") + "\n");
  return name;
}

const hashOf = (lines: string[]) => loadSchema(lines.join("\n") + "\n").hash;

const BOOK = ["entity Book {", "  id: ID", "  title: String", "  subtitle: String?", "}", "query book(id: ID): Book?"];
const WITHOUT_SUBTITLE = ["entity Book {", "  id: ID", "  title: String", "}", "query book(id: ID): Book?"];
const WITH_ISBN = ["entity Book {", "  id: ID", "  title: String", "  subtitle: String?", "  isbn: String?", "}", "query book(id: ID): Book?"];
const WITH_POLICY = ["entity Book {", "  id: ID", "  title: String", "  subtitle: String?", "}", "query book(id: ID): Book? @allow(read: viewer != null)"];
const retiring = (sunset: string) => [
  "entity Book {",
  "  id: ID",
  "  title: String",
  `  subtitle: String? @deprecated(reason: "part of the title now", sunset: "${sunset}")`,
  "}",
  "query book(id: ID): Book?",
];

describe("rayfold check", { timeout: 60_000 }, () => {
  it("passes a valid schema and prints its hash", async () => {
    const run = await rayfold("check", file("book.rayfold", BOOK));
    expect(run).toEqual({ status: 0, stdout: `OK: book.rayfold is valid (hash ${hashOf(BOOK).slice(0, 12)})\n`, stderr: "" });
  });

  it("fails a schema that does not validate, pointing at the line with a caret and the likely fix", async () => {
    const run = await rayfold("check", file("typo.rayfold", ["entity Book {", "  id: ID", "  title: Strng", "}", "query book(id: ID): Book?"]));
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(
      [
        "error    unknown-type  Book.title: Unknown type Strng",
        " --> typo.rayfold:3:3",
        "  |",
        "3 |   title: Strng",
        "  |   ^^^^^",
        "  = did you mean String?",
        "",
        "",
      ].join("\n"),
    );
  });

  it("fails text that does not parse, at the line and column where it breaks", async () => {
    const run = await rayfold("check", file("syntax.rayfold", ["entity Book {", "  id: ID", "  title String", "}"]));
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(
      ['error    syntax  Expected ":" but found "String" (3:9)', " --> syntax.rayfold:3:9", "  |", "3 |   title String", "  |         ^", ""].join("\n"),
    );
  });

  it("guard - shows a warning where it is, and still passes", async () => {
    const schema = ["entity Book {", "  id: ID", "  title: String", "}", "object Shelf { label: String }", "query book(id: ID): Book?"];
    const run = await rayfold("check", file("unreachable.rayfold", schema));
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(
      [
        "warning  unreachable  Shelf: object Shelf is not reachable from any operation",
        " --> unreachable.rayfold:5:8",
        "  |",
        "5 | object Shelf { label: String }",
        "  |        ^^^^^",
        "",
        `OK: unreachable.rayfold is valid (hash ${hashOf(schema).slice(0, 12)})`,
        "",
      ].join("\n"),
    );
  });
});

describe("rayfold check --against", { timeout: 60_000 }, () => {
  it("fails on a removed field, and says what broke", async () => {
    const run = await rayfold("check", file("new.rayfold", WITHOUT_SUBTITLE), "--against", file("old.rayfold", BOOK));
    expect(run.status).toBe(1);
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(
      [
        "BREAKING  Book.subtitle: field Book.subtitle removed (deprecate with a sunset date first) [field-removed]",
        "",
        "FAILED: breaking changes against old.rayfold",
        "",
      ].join("\n"),
    );
  });

  it("guard - passes an added field", async () => {
    const run = await rayfold("check", file("new.rayfold", WITH_ISBN), "--against", file("old.rayfold", BOOK));
    expect(run).toEqual({ status: 0, stdout: "ok        Book.isbn: field added [field-added]\n\nOK: compatible with old.rayfold (1 change)\n", stderr: "" });
  });

  it("allows removing a field whose sunset date has passed", async () => {
    // dates far from today either way, so the verdict cannot depend on when the test runs
    const run = await rayfold("check", file("new.rayfold", WITHOUT_SUBTITLE), "--against", file("old.rayfold", retiring("2000-01-01")));
    expect(run).toEqual({
      status: 0,
      stdout: "ok        Book.subtitle: field Book.subtitle removed after its sunset date [field-removed-after-sunset]\n\nOK: compatible with old.rayfold (1 change)\n",
      stderr: "",
    });
  });

  it("guard - refuses the same removal before the sunset date", async () => {
    const run = await rayfold("check", file("new.rayfold", WITHOUT_SUBTITLE), "--against", file("old.rayfold", retiring("2999-12-31")));
    expect(run.status).toBe(1);
    expect(run.stdout).toBe(
      "BREAKING  Book.subtitle: field Book.subtitle removed (deprecate with a sunset date first) [field-removed]\n\nFAILED: breaking changes against old.rayfold\n",
    );
  });

  it("--strict fails on a warning", async () => {
    const run = await rayfold("check", file("new.rayfold", WITH_POLICY), "--against", file("old.rayfold", BOOK), "--strict");
    expect(run.status).toBe(1);
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(
      "warning   book(): a policy was added where none existed; some callers may now be denied [policy-added]\n\nFAILED: warnings against old.rayfold (--strict)\n",
    );
  });

  it("guard - without --strict the same warning passes", async () => {
    const run = await rayfold("check", file("new.rayfold", WITH_POLICY), "--against", file("old.rayfold", BOOK));
    expect(run).toEqual({
      status: 0,
      stdout: "warning   book(): a policy was added where none existed; some callers may now be denied [policy-added]\n\nOK: compatible with old.rayfold (1 change)\n",
      stderr: "",
    });
  });

  it("guard - --strict still passes a change that is only compatible", async () => {
    const run = await rayfold("check", file("new.rayfold", WITH_ISBN), "--against", file("old.rayfold", BOOK), "--strict");
    expect(run).toEqual({ status: 0, stdout: "ok        Book.isbn: field added [field-added]\n\nOK: compatible with old.rayfold (1 change)\n", stderr: "" });
  });

  it("writes a lock file, and a later check compares with it without being told to", async () => {
    file("book.rayfold", BOOK);
    file("next.rayfold", WITHOUT_SUBTITLE);

    // nothing locked yet, so there is nothing to compare with
    const before = await rayfold("check", "next.rayfold");
    expect(before).toEqual({ status: 0, stdout: `OK: next.rayfold is valid (hash ${hashOf(WITHOUT_SUBTITLE).slice(0, 12)})\n`, stderr: "" });

    const { hash, ir } = loadSchema(BOOK.join("\n") + "\n");
    const lock = await rayfold("lock", "book.rayfold");
    expect(lock).toEqual({ status: 0, stdout: `wrote rayfold.lock.json (hash ${hash.slice(0, 12)})\n`, stderr: "" });
    const written = JSON.parse(readFileSync(join(work, "rayfold.lock.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(written).sort()).toEqual(["hash", "ir", "lockedAt", "rayfold"]);
    expect(written).toMatchObject({ rayfold: "0.1", hash, ir: JSON.parse(JSON.stringify(ir)) as unknown });
    expect(Number.isNaN(Date.parse(String(written["lockedAt"])))).toBe(false);

    const after = await rayfold("check", "next.rayfold");
    expect(after.status).toBe(1);
    expect(after.stdout).toBe(
      "BREAKING  Book.subtitle: field Book.subtitle removed (deprecate with a sunset date first) [field-removed]\n\nFAILED: breaking changes against rayfold.lock.json\n",
    );
  });
});

describe("rayfold check --unused", { timeout: 60_000 }, () => {
  const SCHEMA = [
    "entity Book {",
    "  id: ID",
    "  title: String",
    '  subtitle: String? @deprecated(reason: "part of the title now", sunset: "2999-12-31")',
    "  isbn: String?",
    "}",
    "query book(id: ID): Book?",
    "query books: [Book]",
  ];
  // far future and the epoch: always inside a 30-day window and always outside it, whatever today is
  const usage = (): string => {
    const seen = (op: string, path: string, client: string, lastSeen: string) => ({ op, path, client, lastSeen, count: 1 });
    writeFileSync(
      join(work, "usage.json"),
      JSON.stringify([
        seen("book", "", "web", "2999-01-01T00:00:00Z"),
        seen("book", "Book.id", "web", "2999-01-01T00:00:00Z"),
        seen("book", "Book.title", "ios", "2999-01-01T00:00:00Z"),
        seen("book", "Book.subtitle", "web", "2999-01-01T00:00:00Z"),
        seen("book", "Book.subtitle", "ios", "2999-01-01T00:00:00Z"),
        seen("book", "Book.isbn", "web", "1970-01-01T00:00:00Z"),
      ]),
    );
    return "usage.json";
  };

  it("lists exactly the members no client asked for, and who still asks for a deprecated one", async () => {
    const run = await rayfold("check", file("book.rayfold", SCHEMA), "--unused", usage());
    expect(run).toEqual({
      status: 0,
      stdout: [
        "unused      books(): no traffic",
        "still used  Book.subtitle: ios, web",
        "unused      Book.isbn: no traffic",
        "",
        "2 members with no traffic from 2 clients; 1 record older than the window.",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  it("guard - a window wide enough to take in the old record counts it as traffic", async () => {
    const run = await rayfold("check", file("book.rayfold", SCHEMA), "--unused", usage(), "--since", "40000d");
    expect(run).toEqual({
      status: 0,
      stdout: ["unused      books(): no traffic", "still used  Book.subtitle: ios, web", "", "1 member with no traffic from 2 clients; 0 records older than the window.", ""].join("\n"),
      stderr: "",
    });
  });

  it("refuses a window it cannot read", async () => {
    const run = await rayfold("check", file("book.rayfold", SCHEMA), "--unused", usage(), "--since", "1x");
    expect(run).toEqual({ status: 2, stdout: "", stderr: "--since expects a window such as 30d, 12h or 90m, not 1x\n" });
  });
});

describe("rayfold import", { timeout: 60_000 }, () => {
  it("prints the schema a GraphQL SDL describes, and on stderr what it could not say", async () => {
    const sdl = file("shop.graphql", ["type Book {", "  id: ID!", "  title: String!", "  rating: Int", "}", "", "type Query {", "  book(id: ID!): Book", "}", "", "type Mutation {", "  restock(id: ID!, qty: Int!): Book!", "}"]);
    const run = await rayfold("import", "graphql", sdl);
    expect(run).toEqual({
      status: 0,
      stdout: ["entity Book {", "  id: ID", "  title: String", "  rating: Int?", "}", "", "query book(id: ID): Book?", "", "command restock(id: ID, qty: Int): Book", ""].join("\n"),
      stderr: 'note      restock: a mutation says nothing about what it can fail with; add "throws" once you know.\n',
    });
  });

  it("prints the schema an OpenAPI document describes", async () => {
    writeFileSync(
      join(work, "shop.json"),
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Shop", version: "1" },
        components: {
          schemas: { Book: { type: "object", required: ["id", "title"], properties: { id: { type: "string" }, title: { type: "string" }, rating: { type: "integer" } } } },
        },
        paths: {
          "/books/{id}": {
            get: {
              operationId: "getBook",
              parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
              responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Book" } } } } },
            },
          },
        },
      }),
    );
    const run = await rayfold("import", "openapi", "shop.json");
    expect(run).toEqual({
      status: 0,
      stdout: ["entity Book {", "  id: ID", "  title: String", "  rating: Int?", "}", "", 'query getBook(id: String): Book @http(method: GET, path: "/books/{id}")', ""].join("\n"),
      stderr: "",
    });
  });
});

describe("rayfold mock", { timeout: 60_000 }, () => {
  const SCHEMA = [
    "entity Book {",
    "  id: ID",
    '  title: String @example("Dune")',
    "  stock: Int @range(min: 5, max: 7)",
    "}",
    "event StockChanged { bookId: ID, stock: Int }",
    "query book(id: ID): Book?",
    "stream stockUpdates(bookId: ID): StockChanged",
  ];

  it("serves the schema on the port it got, and answers a batch holding a query and a stream", async () => {
    const proc = start(["mock", file("shop.rayfold", SCHEMA), "--port", "0"]);
    await bounded(
      new Promise<void>((ready) => {
        const check = () => proc.stdout.includes("the same call always gives the same answer\n") && ready();
        proc.child.stdout.on("data", check);
        check();
      }),
      "mock prints that it is listening",
      START_MS,
    );

    const port = /http:\/\/localhost:(\d+)\/rayfold\n/.exec(proc.stdout)?.[1];
    expect(port).toBeDefined();
    expect(port).not.toBe("0");
    expect(proc.stdout).toBe(
      [
        `Rayfold mock of shop.rayfold (schema ${hashOf(SCHEMA).slice(0, 12)})`,
        `  HTTP      http://localhost:${port}/rayfold`,
        `  Explorer  http://localhost:${port}/rayfold/explorer`,
        "  the same call always gives the same answer",
        "",
      ].join("\n"),
    );

    const res = await bounded(
      fetch(`http://localhost:${port}/rayfold`, {
        method: "POST",
        headers: { "content-type": "application/rayfold+json" },
        body: JSON.stringify({ ops: [{ id: 1, op: "book", args: { id: "b1" } }, { id: 2, op: "stockUpdates", args: { bookId: "b1" } }] }),
      }),
      "mock answers the batch",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/rayfold-frames+json");
    const frames = (await bounded(res.text(), "mock finishes the batch")).trimEnd().split("\n").map((line) => JSON.parse(line) as { id: number });
    expect(frames).toHaveLength(5);
    // each op keeps its own order; how the two interleave is up to the server
    expect(frames.filter((f) => f.id === 1)).toEqual([{ id: 1, data: { $type: "Book", id: "book-728", title: "Dune", stock: 5 }, meta: { cost: 1 }, fin: true }]);
    expect(frames.filter((f) => f.id === 2)).toEqual([
      { id: 2, item: { bookId: "stockUpdates-229", stock: 39 } },
      { id: 2, item: { bookId: "stockUpdates-734", stock: 22 } },
      { id: 2, item: { bookId: "stockUpdates-983", stock: 38 } },
      { id: 2, fin: true },
    ]);

    const root = await bounded(fetch(`http://localhost:${port}/`, { redirect: "manual" }), "mock answers /");
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("/rayfold/explorer");
    expect(proc.stderr).toBe("");
  });
});

describe("rayfold dev", { timeout: 60_000 }, () => {
  it("serves an example on the port it got, as the caller its token names, with the explorer beside it", async () => {
    const proc = start(["dev", fileURLToPath(new URL("../../../examples/bookstore-ts", import.meta.url)), "--port", "0"]);
    await bounded(
      new Promise<void>((ready) => {
        const check = () => /\n {2}schema {4}\w+\n$/.test(proc.stdout) && ready();
        proc.child.stdout.on("data", check);
        check();
      }),
      "dev prints that it is listening",
      START_MS,
    );

    const port = /http:\/\/localhost:(\d+)\/\n/.exec(proc.stdout)?.[1];
    expect(port).toBeDefined();
    expect(port).not.toBe("0");
    expect(proc.stdout).toBe(
      [
        `Rayfold dev server: http://localhost:${port}/`,
        `  Explorer  http://localhost:${port}/rayfold/explorer`,
        `  HTTP      http://localhost:${port}/rayfold      (POST/QUERY batches, GET /rayfold/{op}, /rayfold/manifest)`,
        `  WebSocket ws://localhost:${port}/rayfold/ws    (subprotocol rayfold.0.1)`,
        `  MCP       http://localhost:${port}/mcp      (Streamable HTTP, ${MCP_PROTOCOL_VERSION})`,
        `  schema    ${createBookstore().server.hash.slice(0, 12)}`,
        "",
      ].join("\n"),
    );

    const restock = async (authorization: string, key: string) => {
      const res = await bounded(
        fetch(`http://localhost:${port}/rayfold`, {
          method: "POST",
          headers: { "content-type": "application/rayfold+json", authorization },
          body: JSON.stringify({ ops: [{ id: 1, op: "restock", args: { bookId: "b1", qty: 1 }, key, shape: "{ id stock }" }] }),
        }),
        `dev answers a restock as ${authorization}`,
      );
      return (await bounded(res.text(), "the restock's frames")).trimEnd().split("\n").map((line) => JSON.parse(line) as unknown);
    };
    expect(await restock("Bearer u1", "0123456789abcdef")).toEqual([{ id: 1, error: { code: "permission_denied", message: "Not allowed to access restock()" }, fin: true }]);
    // guard: the token dev reads as an admin may restock
    const book = { $type: "Book", id: "b1", stock: 6 };
    expect(await restock("Bearer admin", "fedcba9876543210")).toEqual([{ id: 1, ok: book, patch: [{ set: "Book:b1", value: book }], meta: { cost: 1 }, fin: true }]);

    const explorer = await bounded(fetch(`http://localhost:${port}/rayfold/explorer`), "dev serves the explorer");
    expect([explorer.status, explorer.headers.get("content-type")]).toEqual([200, "text/html; charset=utf-8"]);
    const root = await bounded(fetch(`http://localhost:${port}/`, { redirect: "manual" }), "dev answers /");
    expect([root.status, root.headers.get("location")]).toEqual([302, "/rayfold/explorer"]);
    expect(proc.stderr).toBe("");
  });
});
