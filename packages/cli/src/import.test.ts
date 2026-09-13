import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSchema, printSchemaText, typeRefToString } from "@rayfold/schema";
import { openApiFor } from "@rayfold/server";
import { irFromOpenApi } from "./import-openapi.ts";
import { irFromGraphql } from "./import-graphql.ts";

const work = mkdtempSync(join(tmpdir(), "rayfold-import-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const OPENAPI = {
  openapi: "3.1.0",
  info: { title: "Bookshop", version: "1.0" },
  components: {
    schemas: {
      Book: {
        type: "object",
        description: "A book on the shelf.",
        required: ["id", "title", "format"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          published: { type: "string", format: "date-time" },
          price: { type: "number", format: "decimal" },
          tags: { type: "array", items: { type: "string" } },
          format: { $ref: "#/components/schemas/Format" },
        },
      },
      Format: { type: "string", enum: ["hardcover", "paperback"] },
      NewBook: { type: "object", required: ["title"], properties: { title: { type: "string" }, tags: { type: "array", items: { type: "string" } } } },
    },
  },
  paths: {
    "/books/{id}": {
      get: {
        operationId: "getBook",
        summary: "One book.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Book" } } } } },
      },
    },
    "/books": {
      get: {
        parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }],
        responses: { "200": { content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Book" } } } } } },
      },
      post: {
        operationId: "createBook",
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/NewBook" } } } },
        responses: { "201": { content: { "application/json": { schema: { $ref: "#/components/schemas/Book" } } } } },
      },
    },
  },
};

const SDL = `
"""A person who writes."""
interface Node { id: ID! }

type Author implements Node {
  id: ID!
  name: String!
  bio: String
}

type Book implements Node {
  id: ID!
  title: String!
  author: Author!
  tags: [String!]!
  rating: Int
}

enum Format { HARDCOVER PAPERBACK }
union Searchable = Book | Author
scalar Url

input BookFilter { titleContains: String, format: Format = HARDCOVER, limit: Int = 20 }

type BookConnection { edges: [Book!]! }

type Query {
  book(id: ID!): Book
  books(filter: BookFilter): BookConnection!
  sync: String
}

type Mutation {
  restock(id: ID!, qty: Int!): Book!
  retire(id: ID!): Boolean @deprecated(reason: "no longer used")
}

type Subscription {
  stockChanged(id: ID!): Int!
}
`;

describe("a schema from an OpenAPI document", () => {
  const { ir, notes } = irFromOpenApi(OPENAPI as never);

  it("reads a GET as a query and a change as a command, each keeping its URL", () => {
    expect(Object.keys(ir.ops).sort()).toEqual(["createBook", "getBook", "getBooks"]);
    expect(ir.ops["getBook"]?.kind).toBe("query");
    expect(ir.ops["createBook"]?.kind).toBe("command");
    expect(ir.ops["getBook"]?.annotations).toEqual([{ name: "http", args: { method: { $ident: "GET" }, path: "/books/{id}" } }]);
    expect(ir.ops["createBook"]?.annotations[0]?.args["path"]).toBe("/books");
    expect(ir.ops["getBook"]?.description).toBe("One book.");
  });

  it("names an operation the document did not name after its method and path", () => {
    expect(ir.ops["getBooks"]?.kind).toBe("query");
    expect(typeRefToString(ir.ops["getBooks"]!.returns)).toBe("[Book]");
    expect(ir.ops["getBooks"]?.args.map((a) => `${a.name}: ${typeRefToString(a.type)}`)).toEqual(["limit: Int?"]);
  });

  it("an object with an id of its own is an entity, and formats become the scalars that mean them", () => {
    const book = ir.types["Book"];
    expect(book?.kind).toBe("entity");
    expect(book && "fields" in book ? book.fields.map((f) => `${f.name}: ${typeRefToString(f.type)}`) : []).toEqual([
      "id: ID",
      "title: String",
      "published: Instant?",
      "price: Decimal?",
      "tags: [String]?",
      "format: Format",
    ]);
    expect(book?.description).toBe("A book on the shelf.");
  });

  it("a string enum becomes an enum, with names a schema can hold", () => {
    const format = ir.types["Format"];
    expect(format?.kind).toBe("enum");
    expect(format && "values" in format ? format.values.map((v) => v.name) : []).toEqual(["HARDCOVER", "PAPERBACK"]);
  });

  it("what a caller sends becomes an input, because an argument cannot be an object", () => {
    expect(ir.types["NewBook"]?.kind).toBe("input");
    expect(ir.ops["createBook"]?.args.map((a) => `${a.name}: ${typeRefToString(a.type)}`)).toEqual(["input: NewBook"]);
  });

  it("copies a type that travels both ways, and says so", () => {
    const both = irFromOpenApi({
      ...OPENAPI,
      paths: {
        "/books": {
          post: {
            operationId: "putBook",
            requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Book" } } } },
            responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Book" } } } } },
          },
        },
      },
    } as never);
    expect(both.ir.types["Book"]?.kind).toBe("entity");
    expect(both.ir.types["BookInput"]?.kind).toBe("input");
    expect(typeRefToString(both.ir.ops["putBook"]!.args[0]!.type)).toBe("BookInput");
    expect(both.notes.some((n) => n.includes("BookInput"))).toBe(true);
  });

  it("writes a schema that parses", () => {
    const text = printSchemaText(ir);
    expect(loadSchema(text).hash).toBe(loadSchema(printSchemaText(loadSchema(text).ir)).hash);
    expect(text).toContain('@http(method: GET, path: "/books/{id}")');
    expect(notes).toEqual([]); // this document says everything the importer needs, so it assumed nothing
  });

  it("comes back from the document this repository publishes", () => {
    const bookstore = loadSchema(readFileSync(new URL("../../../examples/bookstore-ts/bookstore.rayfold", import.meta.url), "utf8"));
    const bound = Object.values(bookstore.ir.ops).filter((op) => op.annotations.some((a) => a.name === "http"));
    expect(bound.length).toBeGreaterThan(0);

    const back = irFromOpenApi(openApiFor(bookstore.ir) as never);
    for (const op of bound) expect(Object.keys(back.ir.ops)).toContain(op.name);
    expect(back.ir.types["Book"]?.kind).toBe("entity");
    expect(() => loadSchema(printSchemaText(back.ir))).not.toThrow();
  });
});

describe("a schema from a GraphQL SDL", () => {
  it("maps the roots, and inverts nullability", async () => {
    const { ir, notes } = await irFromGraphql(SDL);

    expect(ir.ops["book"]?.kind).toBe("query");
    expect(ir.ops["restock"]?.kind).toBe("command");
    expect(ir.ops["stockChanged"]?.kind).toBe("stream");

    // GraphQL is nullable until ! says otherwise; Rayfold is the other way round
    expect(typeRefToString(ir.ops["book"]!.returns)).toBe("Book?");
    expect(typeRefToString(ir.ops["restock"]!.returns)).toBe("Book");
    expect(ir.ops["book"]?.args.map((a) => typeRefToString(a.type))).toEqual(["ID"]);

    const book = ir.types["Book"];
    expect(book?.kind).toBe("entity");
    expect(book && "fields" in book ? book.fields.map((f) => `${f.name}: ${typeRefToString(f.type)}`) : []).toEqual([
      "id: ID",
      "title: String",
      "author: Author",
      "tags: [String]",
      "rating: Int?",
    ]);
    expect(notes.some((n) => n.includes("connection"))).toBe(true);
  });

  it("carries interfaces, unions, inputs with defaults, scalars and deprecations", async () => {
    const { ir } = await irFromGraphql(SDL);
    expect(ir.types["Node"]).toMatchObject({ kind: "object", annotations: [{ name: "interface", args: {} }] });
    expect(ir.types["Book"]).toMatchObject({ implements: ["Node"] });
    expect(ir.types["Searchable"]).toMatchObject({ kind: "union", members: ["Book", "Author"] });
    expect(ir.types["Url"]?.kind).toBe("scalar");

    const filter = ir.types["BookFilter"];
    expect(filter?.kind).toBe("input");
    expect(filter && "fields" in filter ? filter.fields.map((f) => [f.name, f.default]) : []).toEqual([
      ["titleContains", undefined],
      ["format", "HARDCOVER"],
      ["limit", 20],
    ]);
    expect(ir.ops["retire"]?.annotations).toEqual([{ name: "deprecated", args: {} }]);
  });

  it("renames an operation the protocol reserves, and writes a schema that parses", async () => {
    const { ir, notes } = await irFromGraphql(SDL);
    expect(ir.ops["syncOp"]?.kind).toBe("query");
    expect(ir.ops["sync"]).toBeUndefined();
    expect(notes.some((n) => n.includes("reserved"))).toBe(true);
    expect(() => loadSchema(printSchemaText(ir))).not.toThrow();
  });
});

describe("the command itself", () => {
  const main = fileURLToPath(new URL("./main.ts", import.meta.url));
  const root = fileURLToPath(new URL("../../../", import.meta.url));

  function rayfold(args: string[]): { stdout: string; stderr: string; status: number } {
    const run = spawnSync(process.execPath, ["--import", "tsx", main, ...args], { cwd: root, encoding: "utf8" });
    return { stdout: run.stdout ?? "", stderr: run.stderr ?? "", status: run.status ?? 1 };
  }

  it("writes a schema file from an OpenAPI document, and says what it assumed", { timeout: 60_000 }, () => {
    const document = join(work, "openapi.json");
    const out = join(work, "api.rayfold");
    writeFileSync(document, JSON.stringify(OPENAPI));

    const run = rayfold(["import", "openapi", document, "--out", out]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`wrote ${out}`);
    expect(run.stderr).toBe(""); // nothing had to be assumed about this one

    const written = loadSchema(readFileSync(out, "utf8"));
    expect(Object.keys(written.ir.ops).sort()).toEqual(["createBook", "getBook", "getBooks"]);

    // and where the document leaves something out, the note goes to stderr, so the schema on stdout stays a schema
    const thin = join(work, "thin.json");
    writeFileSync(
      thin,
      JSON.stringify({ openapi: "3.1.0", info: { title: "Thin", version: "1" }, paths: { "/ping": { get: { operationId: "ping", responses: { "204": { description: "nothing" } } } } } }),
    );
    const second = rayfold(["import", "openapi", thin]);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("query ping: JSON");
    expect(second.stderr).toContain("no JSON response was described");
  });

  it("guard - it refuses a source it cannot read", { timeout: 60_000 }, () => {
    const run = rayfold(["import", "wsdl", join(work, "openapi.json")]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Unsupported source wsdl");
  });
});
