import { afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadSchema, printSchemaText, typeRefToString } from "@rayfold/schema";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createBindingHandler, createHttpHandler, createRayfoldServer, openApiFor } from "@rayfold/server";
import { irFromOpenApi } from "./import-openapi.ts";
import { irFromGraphql } from "./import-graphql.ts";
import { bounded } from "../../../e2e/wait.ts";

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
    expect(both.notes).toEqual(["Book: it is both sent and returned, so BookInput carries the sending side."]);
  });

  it("writes a schema that parses", () => {
    const text = printSchemaText(ir);
    expect(loadSchema(text).ir).toEqual(ir);
    expect(text).toContain('@http(method: GET, path: "/books/{id}")');
    expect(notes).toEqual([]); // this document says everything the importer needs, so it assumed nothing
  });

  it("comes back from the document this repository publishes", () => {
    const bookstore = loadSchema(readFileSync(new URL("../../../examples/bookstore-ts/bookstore.rayfold", import.meta.url), "utf8"));
    const bound = Object.values(bookstore.ir.ops).filter((op) => op.annotations.some((a) => a.name === "http"));
    expect(bound.length).toBeGreaterThan(0);

    const back = irFromOpenApi(openApiFor(bookstore.ir) as never);
    expect(Object.keys(back.ir.ops).sort()).toEqual(bound.map((op) => op.name).sort());
    expect(back.ir.types["Book"]?.kind).toBe("entity");
    expect(back.notes).toEqual([
      "PageArgs: the protocol defines it, so the document's version was left out and references point at the built-in.",
      "Book.$type: the protocol owns that name, so the field was left out.",
      "Author.$type: the protocol owns that name, so the field was left out.",
      "Review.$type: the protocol owns that name, so the field was left out.",
      "Order.$type: the protocol owns that name, so the field was left out.",
    ]);
    expect(loadSchema(printSchemaText(back.ir)).ir).toEqual(back.ir);
  });
});

describe("an OpenAPI document the importer used to misread", () => {
  const ok = { "200": { content: { "application/json": { schema: { type: "string" } } } } };
  /** The import, printed and read back: the schema an author would keep. */
  const imported = (doc: Record<string, unknown>) => {
    const { ir, notes } = irFromOpenApi(doc);
    const text = printSchemaText(ir);
    const back = loadSchema(text);
    expect(back.ir).toEqual(ir);
    return { ir, notes, text };
  };
  const args = (ir: ReturnType<typeof irFromOpenApi>["ir"], op: string) => ir.ops[op]!.args.map((a) => `${a.name}: ${typeRefToString(a.type)}`);

  it("reads parameters written on the path, and those given by $ref", () => {
    const { ir } = imported({
      components: { parameters: { Id: { name: "id", in: "path", required: true, schema: { type: "string" } }, Lang: { $ref: "#/components/parameters/Lang2" }, Lang2: { name: "lang", in: "query", schema: { type: "string" } } } },
      paths: {
        "/users/{id}": {
          parameters: [{ $ref: "#/components/parameters/Id" }, { name: "verbose", in: "query", schema: { type: "boolean" } }],
          get: { operationId: "getUser", parameters: [{ $ref: "#/components/parameters/Lang" }], responses: ok },
          // an operation's own parameter of the same name and place replaces the path's
          delete: { operationId: "dropUser", parameters: [{ name: "verbose", in: "query", required: true, schema: { type: "integer" } }], responses: ok },
        },
      },
    });
    expect(args(ir, "getUser")).toEqual(["id: String", "verbose: Boolean?", "lang: String?"]);
    expect(args(ir, "dropUser")).toEqual(["id: String", "verbose: Int"]);
  });

  it("guard - without path-level parameters an operation takes only its own", () => {
    const { ir } = imported({ paths: { "/users": { get: { operationId: "users", parameters: [{ name: "q", in: "query", schema: { type: "string" } }], responses: ok } } } });
    expect(args(ir, "users")).toEqual(["q: String?"]);
  });

  it("a body property with a parameter's name is left out, with a note (guard - other properties stay)", () => {
    const { ir, notes } = imported({
      paths: {
        "/users/{id}": {
          put: {
            operationId: "putUser",
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
            requestBody: { content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } } } } },
            responses: ok,
          },
        },
      },
    });
    expect(args(ir, "putUser")).toEqual(["id: String", "name: String?"]);
    expect(notes).toContain("putUser(id): the body property has the name of an argument already taken, so it was left out.");
  });

  it("names that are not names become names, in fields, arguments, types and the path template", () => {
    const { ir, notes, text } = imported({
      components: { schemas: { "user-profile": { type: "object", properties: { "first-name": { type: "string" }, "2fa": { type: "boolean" }, last_name: { type: "string" } } } } },
      paths: {
        "/users/{user-id}": {
          get: {
            operationId: "u",
            parameters: [{ name: "user-id", in: "path", required: true, schema: { type: "string" } }, { name: "sort-by", in: "query", schema: { type: "string" } }],
            responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/user-profile" } } } } },
          },
        },
      },
    });
    expect(Object.keys(ir.types).filter((t) => !ir.types[t]!.builtin)).toEqual(["UserProfile"]);
    expect((ir.types["UserProfile"] as { fields: Array<{ name: string }> }).fields.map((f) => f.name)).toEqual(["firstName", "_2fa", "last_name"]);
    expect(args(ir, "u")).toEqual(["userId: String", "sortBy: String?"]);
    expect(text).toContain('@http(method: GET, path: "/users/{userId}")');
    // the arguments keep what clients send as their wire names, so they need no note
    expect(text).toContain('query u(userId: String @http(name: "user-id"), sortBy: String? @http(name: "sort-by"))');
    // a result has no wire names: its renamed fields stay renamed on the wire, and are noted
    expect((ir.types["UserProfile"] as { fields: Array<{ annotations: unknown[] }> }).fields.map((f) => f.annotations)).toEqual([[], [], []]);
    expect(notes).toEqual([
      "user-profile: not a name a schema can hold, so the type is UserProfile.",
      "UserProfile.first-name: not a name a schema can hold, so the field is firstName.",
      "UserProfile.2fa: not a name a schema can hold, so the field is _2fa.",
    ]);
  });

  it("enum values that read alike are told apart (guard - distinct values keep their names)", () => {
    const { ir, notes } = imported({
      components: { schemas: { E: { enum: ["a-b", "a_b", "c"] } } },
      paths: { "/u": { get: { operationId: "u", parameters: [{ name: "e", in: "query", schema: { $ref: "#/components/schemas/E" } }], responses: ok } } },
    });
    expect((ir.types["E"] as { values: Array<{ name: string }> }).values.map((v) => v.name)).toEqual(["A_B", "A_B_2", "C"]);
    expect(notes).toEqual(['E: "a_b" reads as A_B like an earlier value, so it is A_B_2.']);
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
    expect(notes).toEqual([
      "BookConnection: a connection is not a page. Rayfold pages are Page<T> with @page(cursor) on the field.",
      "sync: the name is reserved by the protocol, so the operation is syncOp.",
      'restock: a mutation says nothing about what it can fail with; add "throws" once you know.',
      'retire: a mutation says nothing about what it can fail with; add "throws" once you know.',
    ]);
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
    expect(ir.ops["retire"]?.annotations).toEqual([{ name: "deprecated", args: { reason: "no longer used" } }]);
  });

  it("renames an operation the protocol reserves, and writes a schema that parses", async () => {
    const { ir, notes } = await irFromGraphql(SDL);
    expect(ir.ops["syncOp"]?.kind).toBe("query");
    expect(ir.ops["sync"]).toBeUndefined();
    expect(notes.filter((n) => n.startsWith("sync"))).toEqual(["sync: the name is reserved by the protocol, so the operation is syncOp."]);
    expect(loadSchema(printSchemaText(ir)).ir).toEqual(ir);
  });

  it("an id of another scalar type is an entity's ID, with a note (guard - an object id or a nullable id is not)", async () => {
    const { ir, notes } = await irFromGraphql(`type User { id: String! name: String } type Item { id: Int! } type Box { id: User! } type Maybe { id: ID } type Query { user(id: String!): User item: Item box: Box maybe: Maybe }`);
    expect(loadSchema(printSchemaText(ir)).ir).toEqual(ir);
    expect(ir.types["User"]).toMatchObject({ kind: "entity", fields: [{ name: "id", type: { kind: "named", name: "ID", nullable: false } }, { name: "name" }] });
    expect(ir.types["Item"]).toMatchObject({ kind: "entity", fields: [{ name: "id", type: { name: "ID" } }] });
    expect(ir.types["Box"]?.kind).toBe("object");
    expect(ir.types["Maybe"]?.kind).toBe("object");
    expect(typeRefToString(ir.ops["user"]!.args[0]!.type)).toBe("String"); // only the identity changes, not arguments
    expect(notes.filter((n) => n.includes(".id:"))).toEqual(["User.id: String became ID, the type an entity's identity has.", "Item.id: Int became ID, the type an entity's identity has."]);
  });

  it("a type named like a built-in is renamed everywhere it is used, with a note (guard - scalar Date is the built-in)", async () => {
    const { ir, notes } = await irFromGraphql(`scalar Date type Page { id: ID! title: String at: Date } union Hit = Page | Other type Other { id: ID! } type Query { page(id: ID!): Page pages: [Page!]! hit: Hit }`);
    expect(loadSchema(printSchemaText(ir)).ir).toEqual(ir);
    expect(ir.types["Page"]).toMatchObject({ builtin: true });
    expect(ir.types["PageType"]).toMatchObject({ kind: "entity", name: "PageType" });
    expect(ir.types["Date"]).toMatchObject({ kind: "scalar", builtin: true });
    expect(typeRefToString(ir.ops["page"]!.returns)).toBe("PageType?");
    expect(typeRefToString(ir.ops["pages"]!.returns)).toBe("[PageType]");
    expect(ir.types["Hit"]).toMatchObject({ members: ["PageType", "Other"] });
    expect(notes).toContain("Page: the protocol has a built-in Page, so this type is PageType.");
    expect(notes.some((n) => n.startsWith("Date:"))).toBe(false);
  });

  it("keeps the reason a deprecation gives (guard - one without a reason has none)", async () => {
    const { ir } = await irFromGraphql(`enum E { A @deprecated(reason: "use B") B } type Query { old: Int @deprecated plain: E @deprecated(reason: "gone") }`);
    expect(ir.ops["old"]?.annotations).toEqual([{ name: "deprecated", args: {} }]);
    expect(ir.ops["plain"]?.annotations).toEqual([{ name: "deprecated", args: { reason: "gone" } }]);
    expect((ir.types["E"] as { values: Array<{ annotations: unknown[] }> }).values[0]!.annotations).toEqual([{ name: "deprecated", args: { reason: "use B" } }]);
    expect(printSchemaText(ir)).toContain('query plain: E? @deprecated(reason: "gone")');
    expect(loadSchema(printSchemaText(ir)).ir).toEqual(ir);
  });
});

describe("an imported schema served over its HTTP bindings", () => {
  const ok = { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Shelf" } } } } };
  const DOC = {
    components: {
      schemas: {
        Shelf: { type: "object", required: ["id"], properties: { id: { type: "string" }, label: { type: "string" }, size: { type: "integer" } } },
        NewShelf: { type: "object", properties: { label: { type: "string" }, size: { type: "integer" } } },
      },
    },
    paths: {
      "/shelves": {
        get: { operationId: "shelves", parameters: [{ name: "size", in: "query", schema: { type: "integer" } }], responses: ok },
        post: { operationId: "addShelf", requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/NewShelf" } } } }, responses: ok },
      },
      "/shelves/{id}": {
        patch: {
          operationId: "relabel",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { label: { type: "string" } } } } } },
          responses: ok,
        },
      },
    },
  };
  const servers: Server[] = [];
  afterAll(() => servers.forEach((s) => (s.closeAllConnections(), s.close())));

  async function serve(text: string): Promise<string> {
    const server = createRayfoldServer({
      schema: text,
      resolvers: {
        Query: { shelves: (a: { size?: number }) => ({ id: "s0", label: "by query", size: a.size ?? null }) },
        Command: {
          addShelf: (a: { input: { label?: string; size?: number } }) => ({ id: "s1", label: a.input.label ?? null, size: a.input.size ?? null }),
          relabel: (a: { id: string; label?: string }) => ({ id: a.id, label: a.label ?? null, size: null }),
        },
      },
    });
    // idempotency keys are scoped to a caller, so a keyed POST needs one
    const handler = createBindingHandler(server, { viewer: () => ({ id: "u1" }) });
    const http = createServer((req, res) => void handler(req, res).then((handled) => handled || res.writeHead(404).end()));
    servers.push(http);
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", () => resolve()));
    return `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  }

  const send = async (url: string, method: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(url, { method, headers: { "content-type": "application/json", ...headers }, signal: AbortSignal.timeout(5_000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json()) as unknown };
  };

  it("binds a request body to the argument it became, whole or spread, so the served schema reads it", async () => {
    const { ir } = irFromOpenApi(DOC);
    expect(ir.ops["addShelf"]!.annotations[0]!.args["body"]).toEqual({ $ident: "input" });
    expect(ir.ops["relabel"]!.annotations[0]!.args["body"]).toBe("*");
    const text = printSchemaText(ir);
    expect(text).toContain('@http(method: POST, path: "/shelves", body: input)');
    expect(text).toContain('@http(method: PATCH, path: "/shelves/{id}", body: "*")');

    const base = await serve(text);
    const key = "key-0123456789abcdef";
    const added = await send(`${base}/shelves`, "POST", { label: "poetry", size: 12 }, { "idempotency-key": key });
    expect(added).toEqual({ status: 200, body: { $type: "Shelf", id: "s1", label: "poetry", size: 12 } });
    const relabelled = await send(`${base}/shelves/s7`, "PATCH", { label: "drama" });
    expect(relabelled).toEqual({ status: 200, body: { $type: "Shelf", id: "s7", label: "drama", size: null } });
  });

  it("guard - a GET that takes only query parameters binds no body, and still reads its parameters", async () => {
    const { ir } = irFromOpenApi(DOC);
    expect(ir.ops["shelves"]!.annotations).toEqual([{ name: "http", args: { method: { $ident: "GET" }, path: "/shelves" } }]);
    const base = await serve(printSchemaText(ir));
    expect(await send(`${base}/shelves?size=3`, "GET")).toEqual({ status: 200, body: { $type: "Shelf", id: "s0", label: "by query", size: 3 } });
  });
});

describe("an imported schema reads the names its REST clients already send", () => {
  const returnsPerson = { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Person" } } } } };
  const DOC = {
    openapi: "3.1.0",
    info: { title: "People", version: "1" },
    components: {
      schemas: {
        Person: { type: "object", required: ["id"], properties: { id: { type: "string" }, echo: { type: "string" } } },
        NewPerson: { type: "object", required: ["first-name", "home-address"], properties: { "first-name": { type: "string" }, "home-address": { $ref: "#/components/schemas/Address" } } },
        Address: { type: "object", properties: { "zip-code": { type: "string" } } },
      },
    },
    paths: {
      "/people": {
        get: {
          operationId: "findPeople",
          parameters: [{ name: "first-name", in: "query", schema: { type: "string" } }, { name: "max-count", in: "query", schema: { type: "integer" } }],
          responses: returnsPerson,
        },
        post: { operationId: "addPerson", requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/NewPerson" } } } }, responses: returnsPerson },
      },
      "/people/{person-id}": {
        patch: {
          operationId: "renamePerson",
          parameters: [{ name: "person-id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { "first-name": { type: "string" }, "nick-names": { type: "array", items: { type: "string" } } } } } } },
          responses: returnsPerson,
        },
      },
    },
  };
  const KEY = "key-0123456789abcdef";
  const servers: Server[] = [];
  afterAll(() => servers.forEach((s) => (s.closeAllConnections(), s.close())));

  /** Every resolver answers with the arguments it received, so a test sees exactly what the binding read. */
  async function serve(text: string): Promise<string> {
    const echo = (id: string) => (args: unknown) => ({ id, echo: JSON.stringify(args) });
    const server = createRayfoldServer({ schema: text, resolvers: { Query: { findPeople: echo("p0") }, Command: { addPerson: echo("p1"), renamePerson: echo("p2") } } });
    const bindings = createBindingHandler(server, { viewer: () => ({ id: "u1" }) });
    const rayfold = createHttpHandler(server, { viewer: () => ({ id: "u1" }) });
    const http = createServer((req, res) => void bindings(req, res).then((handled) => (handled ? undefined : rayfold(req, res))));
    servers.push(http);
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", () => resolve()));
    return `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  }

  const send = async (url: string, method: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(url, { method, headers: { "content-type": "application/json", ...headers }, signal: AbortSignal.timeout(5_000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const person = (id: string, args: unknown) => ({ $type: "Person", id, echo: JSON.stringify(args) });

  const imported = () => {
    const { ir, notes } = irFromOpenApi(DOC);
    const text = printSchemaText(ir);
    expect(loadSchema(text).ir).toEqual(ir);
    return { ir, notes, text };
  };

  it("writes each renamed parameter and property with its original name, and notes none of them", () => {
    const { notes, text } = imported();
    expect(text).toContain('query findPeople(firstName: String? @http(name: "first-name"), maxCount: Int? @http(name: "max-count")): Person @http(method: GET, path: "/people")');
    expect(text).toContain('command renamePerson(personId: String @http(name: "person-id"), firstName: String? @http(name: "first-name"), nickNames: [String]? @http(name: "nick-names")): Person @http(method: PATCH, path: "/people/{personId}", body: "*")');
    expect(text).toMatch(/input NewPerson \{\s+firstName: String @http\(name: "first-name"\)\s+homeAddress: Address @http\(name: "home-address"\)\s+\}/);
    expect(text).toMatch(/input Address \{\s+zipCode: String\? @http\(name: "zip-code"\)\s+\}/);
    expect(notes).toEqual([]);
  });

  it("serves query parameters, a spread body and a body-bound input, nested, under the names clients send", async () => {
    const base = await serve(imported().text);
    expect(await send(`${base}/people?first-name=Ada&max-count=2`, "GET")).toEqual({ status: 200, body: person("p0", { firstName: "Ada", maxCount: 2 }) });
    const added = await send(`${base}/people`, "POST", { "first-name": "Ada", "home-address": { "zip-code": "02139" } }, { "idempotency-key": KEY });
    expect(added).toEqual({ status: 200, body: person("p1", { input: { firstName: "Ada", homeAddress: { zipCode: "02139" } } }) });
    const renamed = await send(`${base}/people/p7`, "PATCH", { "first-name": "Grace", "nick-names": ["Amazing"] });
    expect(renamed).toEqual({ status: 200, body: person("p2", { personId: "p7", firstName: "Grace", nickNames: ["Amazing"] }) });
  });

  it("an invalid value is reported under the name the client sent", async () => {
    const base = await serve(imported().text);
    const count = await send(`${base}/people?max-count=many`, "GET");
    expect([count.status, count.body["detail"]]).toEqual([400, "findPeople().max-count: expected Int"]);
    const zip = await send(`${base}/people`, "POST", { "first-name": "Ada", "home-address": { "zip-code": 2139 } }, { "idempotency-key": KEY });
    expect([zip.status, zip.body["detail"]]).toEqual([400, "addPerson().input.home-address.zip-code: expected String"]);
  });

  it("guard - a binding does not take the schema name in place of the wire name, at any depth", async () => {
    const base = await serve(imported().text);
    const query = await send(`${base}/people?firstName=Ada`, "GET");
    expect([query.status, query.body["detail"]]).toEqual([400, "findPeople().firstName: unknown argument"]);
    const spread = await send(`${base}/people/p7`, "PATCH", { firstName: "Grace" });
    expect([spread.status, spread.body["detail"]]).toEqual([400, "renamePerson().firstName: unknown argument"]);
    const nested = await send(`${base}/people`, "POST", { "first-name": "Ada", "home-address": { zipCode: "02139" } }, { "idempotency-key": KEY });
    expect([nested.status, nested.body["detail"]]).toEqual([400, "addPerson().input.home-address.zipCode: unknown argument"]);
  });

  it("guard - /rayfold keeps the schema names, and does not read the wire names", async () => {
    const base = await serve(imported().text);
    const call = async (args: unknown) => {
      const res = await fetch(`${base}/rayfold`, {
        method: "POST",
        headers: { "content-type": "application/rayfold+json" },
        body: JSON.stringify({ ops: [{ id: 1, op: "addPerson", key: KEY, args }] }),
        signal: AbortSignal.timeout(5_000),
      });
      return (await res.text()).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)[0];
    };
    const ok = await call({ input: { firstName: "Ada", homeAddress: { zipCode: "02139" } } });
    expect(ok?.["ok"]).toEqual(person("p1", { input: { firstName: "Ada", homeAddress: { zipCode: "02139" } } }));
    const wire = await call({ input: { "first-name": "Ada" } });
    expect(wire?.["error"]).toMatchObject({ code: "invalid_argument", message: "addPerson().input.first-name: unknown argument" });
  });

  it("publishes the names clients send in its OpenAPI document, so importing that document gives the same schema", async () => {
    const { ir } = imported();
    const base = await serve(printSchemaText(ir));
    const doc = (await (await fetch(`${base}/rayfold/openapi.json`, { signal: AbortSignal.timeout(5_000) })).json()) as {
      paths: Record<string, Record<string, { parameters: Array<{ name: string; in: string }>; requestBody?: { content: Record<string, { schema: { properties: Record<string, unknown> } }> } }>>;
      components: { schemas: Record<string, { properties: Record<string, unknown>; required?: string[] }> };
    };
    expect(Object.keys(doc.paths)).toEqual(["/people", "/people/{person-id}"]);
    expect(doc.paths["/people"]!["get"]!.parameters.map((p) => `${p.in} ${p.name}`)).toEqual(["query first-name", "query max-count", "query shape"]);
    const patch = doc.paths["/people/{person-id}"]!["patch"]!;
    expect(patch.parameters.filter((p) => p.in === "path").map((p) => p.name)).toEqual(["person-id"]);
    expect(Object.keys(patch.requestBody!.content["application/json"]!.schema.properties)).toEqual(["first-name", "nick-names"]);
    expect(Object.keys(doc.components.schemas["NewPerson"]!.properties)).toEqual(["first-name", "home-address"]);
    expect(doc.components.schemas["NewPerson"]!.required).toEqual(["first-name", "home-address"]);
    expect(Object.keys(doc.components.schemas["Address"]!.properties)).toEqual(["zip-code"]);
    // results keep their schema names
    expect(Object.keys(doc.components.schemas["Person"]!.properties)).toEqual(["$type", "id", "echo"]);

    const back = irFromOpenApi(doc as never);
    // the document also offers every GET the `shape` parameter, which comes back as an argument of its own
    const wire = (op: string) => back.ir.ops[op]!.args.filter((a) => a.name !== "shape").map((a) => [a.name, a.annotations]);
    for (const op of ["findPeople", "renamePerson"]) expect(wire(op)).toEqual(ir.ops[op]!.args.map((a) => [a.name, a.annotations]));
    const fields = (i: typeof ir, type: string) => (i.types[type] as { fields: Array<{ name: string; annotations: unknown[] }> }).fields.map((f) => [f.name, f.annotations]);
    for (const type of ["NewPerson", "Address"]) expect(fields(back.ir, type)).toEqual(fields(ir, type));
  });
});

describe("the command itself", { timeout: 60_000 }, () => {
  const main = fileURLToPath(new URL("./main.ts", import.meta.url));
  // by URL, because the child runs in `work`, which has no node_modules to find `tsx` in
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

  /** The CLI run from `work`; a hung run fails the test instead of blocking the worker. */
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

  it("writes a schema file from an OpenAPI document, and says what it assumed", async () => {
    writeFileSync(join(work, "openapi.json"), JSON.stringify(OPENAPI));

    expect(await rayfold(["import", "openapi", "openapi.json", "--out", "api.rayfold"])).toEqual({ status: 0, stdout: "wrote api.rayfold\n", stderr: "" });
    expect(readFileSync(join(work, "api.rayfold"), "utf8")).toBe(printSchemaText(irFromOpenApi(OPENAPI as never).ir));

    // and where the document leaves something out, the note goes to stderr, so the schema on stdout stays a schema
    writeFileSync(
      join(work, "thin.json"),
      JSON.stringify({ openapi: "3.1.0", info: { title: "Thin", version: "1" }, paths: { "/ping": { get: { operationId: "ping", responses: { "204": { description: "nothing" } } } } } }),
    );
    expect(await rayfold(["import", "openapi", "thin.json"])).toEqual({
      status: 0,
      stdout: 'query ping: JSON @http(method: GET, path: "/ping")\n',
      stderr: "note      ping: no JSON response was described, so it returns JSON.\n",
    });
  });

  it("writes a schema that checks from documents it used to misread, keeping the parameter names clients send", async () => {
    writeFileSync(
      join(work, "dashed.json"),
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Dashed", version: "1" },
        components: { parameters: { Id: { name: "user-id", in: "path", required: true, schema: { type: "string" } } } },
        paths: { "/users/{user-id}": { parameters: [{ $ref: "#/components/parameters/Id" }], get: { operationId: "user", responses: { "200": { content: { "application/json": { schema: { type: "string" } } } } } } } },
      }),
    );
    // the renamed parameter keeps the name clients send as its wire name, so nothing is left to note
    expect(await rayfold(["import", "openapi", "dashed.json", "--out", "dashed.rayfold"])).toEqual({ status: 0, stdout: "wrote dashed.rayfold\n", stderr: "" });
    expect(readFileSync(join(work, "dashed.rayfold"), "utf8")).toBe('query user(userId: String @http(name: "user-id")): String @http(method: GET, path: "/users/{userId}")\n');

    writeFileSync(join(work, "page.graphql"), `type Page { id: String! } type Query { page: Page }`);
    const graphql = await rayfold(["import", "graphql", "page.graphql", "--out", "page.rayfold"]);
    expect(graphql).toEqual({
      status: 0,
      stdout: "wrote page.rayfold\n",
      stderr: "note      Page: the protocol has a built-in Page, so this type is PageType.\nnote      PageType.id: String became ID, the type an entity's identity has.\n",
    });
    expect((await rayfold(["check", "page.rayfold"])).status).toBe(0);
  });

  it("guard - it refuses a source it cannot read", async () => {
    writeFileSync(join(work, "openapi.json"), JSON.stringify(OPENAPI));
    expect(await rayfold(["import", "wsdl", "openapi.json"])).toEqual({ status: 1, stdout: "", stderr: "Unsupported source wsdl (openapi, graphql)\n" });
  });
});
