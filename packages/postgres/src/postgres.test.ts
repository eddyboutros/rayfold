import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { evalExpr, loadSchema, parseExprText, parseShapeText, type ExprEnv } from "@rayfold/schema";
import { createRayfoldServer, decide, type RayfoldContext, type RayfoldServer } from "@rayfold/server";
import pg from "pg";
import { compilePolicy, createPgStore, type PageRequest, type PgStore, type PolicyColumn, type Queryable, type Row } from "./index.ts";

// every test boots its own PGlite, a Postgres compiled to WASM, which on a busy runner takes seconds by itself, the
// first one in a worker longest; the waits for a signal inside each test keep their own 5 s bound
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const SCHEMA = `
entity Author { id: ID name: String books(page: PageArgs = { first: 10 }): Page<Book> }
entity Book { id: ID title: String price: Decimal stock: Int author: Author }
entity Order @allow(read: viewer.id == customerId || viewer.role == "admin") { id: ID customerId: ID? total: Decimal }
query book(id: ID): Book?
query books(page: PageArgs = { first: 20 }): Page<Book>
query orders: [Order]
query ordersPage(page: PageArgs = { first: 20 }): Page<Order>
query ordersUnfiltered: [Order]
`;

let db: PGlite;
/** Every statement the store sends, with how many rows came back. */
let log: Array<{ sql: string; rows: number }>;
let counted: Queryable;

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE authors (id text PRIMARY KEY, name text NOT NULL);
    CREATE TABLE books (id text PRIMARY KEY, title text NOT NULL, price numeric(10, 2) NOT NULL, stock int NOT NULL, author_id text NOT NULL REFERENCES authors (id));
    CREATE TABLE "order" (id text PRIMARY KEY, customer_id text, total numeric(10, 2) NOT NULL);
    INSERT INTO authors VALUES ('a1', 'Ursula K. Le Guin'), ('a2', 'Octavia E. Butler'), ('a3', 'Italo Calvino');
    INSERT INTO books VALUES
      ('b1', 'The Dispossessed', 12.99, 5, 'a1'), ('b2', 'Kindred', 9.50, 2, 'a2'), ('b3', 'Invisible Cities', 11.00, 0, 'a3'),
      ('b4', 'The Left Hand of Darkness', 10.00, 4, 'a1'), ('b5', 'Dawn', 8.00, 7, 'a2'), ('b6', 'The Lathe of Heaven', 9.00, 1, 'a1'),
      ('b7', 'If on a winter''s night a traveler', 13.00, 3, 'a3');
    INSERT INTO "order" VALUES ('o1', 'u1', 12.50), ('o2', 'u2', 8.00), ('o3', 'u1', 30.00), ('o4', NULL, 5.00);
  `);
  log = [];
  counted = {
    query: async (text, params) => {
      const r = await db.query(text, params);
      log.push({ sql: text, rows: r.rows.length });
      return r as never;
    },
  };
});

afterEach(async () => {
  await db.close();
});

/** `screen: true` wires the Postgres guide's setup: list resolvers hand `ctx.shape` to `screen`, and no field loaders. */
function bookstore(sql: Queryable, opts: { screen?: boolean } = {}): { server: RayfoldServer; store: PgStore } {
  const { ir } = loadSchema(SCHEMA);
  const store = createPgStore(sql, {
    ir,
    naming: "snake",
    tables: {
      Author: { table: "authors", relations: { books: { type: "Book", kind: "page", key: "authorId" } } },
      Book: { table: "books", columns: { authorId: "author_id" }, relations: { author: { type: "Author", kind: "one", key: "authorId" } } },
      Order: { table: "order" },
    },
  });
  if (opts.screen) {
    const server = createRayfoldServer({
      schema: SCHEMA,
      resolvers: {
        Query: {
          books: (a: { page: PageRequest }, ctx) => store.screen("Book", ctx.shape!, a.page, {}, ctx),
          ordersPage: (a: { page: PageRequest }, ctx) => store.screen("Order", ctx.shape!, a.page, {}, ctx),
        },
      },
    });
    return { server, store };
  }
  const server = createRayfoldServer({
    schema: SCHEMA,
    resolvers: {
      Query: {
        book: async (a: { id: string }, ctx) => (await store.byIds("Book", [a.id], ctx))[0],
        books: (a: { page: PageRequest }, ctx) => store.page("Book", a.page, {}, ctx),
        orders: (_a, ctx) => store.find("Order", {}, ctx),
        ordersPage: (a: { page: PageRequest }, ctx) => store.page("Order", a.page, {}, ctx),
        // a resolver that drops the pushed-down policy on the floor
        ordersUnfiltered: (_a, ctx) => store.find("Order", {}, { viewer: ctx.viewer }),
      },
      Book: { author: (parents: Row[], _a: unknown, ctx: RayfoldContext) => store.byIds("Author", parents.map((b) => b["authorId"]), ctx) },
      Author: { books: (parents: Row[], a: { page: PageRequest }, ctx: RayfoldContext) => store.pagesByField("Book", "authorId", parents.map((p) => p["id"]), a.page, ctx) },
    },
  });
  return { server, store };
}

const fetched = () => log.reduce((n, l) => n + l.rows, 0);

describe("@rayfold/postgres on a real Postgres (PGlite)", () => {
  it("serves a nested shape with one query per level: a page of books, their authors, and each author's first books", async () => {
    const { server } = bookstore(counted);
    const [f] = await server.collect({ ops: [{ id: 1, op: "books", args: { page: { first: 3 } }, shape: "{ total hasMore cursor items { id title author { name books(page: { first: 2 }) { total items { id } } } } }" }] });
    const book = (id: string) => ({ $type: "Book", id });
    const row = (id: string, title: string, name: string, total: number, ids: string[]) => ({ $type: "Book", id, title, author: { $type: "Author", name, books: { total, items: ids.map(book) } } });
    expect(f).toEqual({
      id: 1,
      data: {
        total: 7,
        hasMore: true,
        cursor: "b3",
        items: [
          row("b1", "The Dispossessed", "Ursula K. Le Guin", 3, ["b1", "b4"]),
          row("b2", "Kindred", "Octavia E. Butler", 2, ["b2", "b5"]),
          row("b3", "Invisible Cities", "Italo Calvino", 2, ["b3", "b7"]),
        ],
      },
      meta: { cost: 20 },
      fin: true,
    });
    expect(log).toHaveLength(3);
  });

  it("serves the whole screen in one statement: the page, each book's author, and that author's own books", async () => {
    const { store } = bookstore(counted);
    const shape = parseShapeText("{ id title author { name books(page: { first: 2 }) { total items { id } } } }");
    const page = await store.screen("Book", shape, { first: 3 });
    expect(page).toEqual({
      total: 7,
      hasMore: true,
      cursor: "b3",
      items: [
        { id: "b1", title: "The Dispossessed", author: { name: "Ursula K. Le Guin", books: { total: 3, hasMore: true, cursor: "b4", items: [{ id: "b1" }, { id: "b4" }] } } },
        { id: "b2", title: "Kindred", author: { name: "Octavia E. Butler", books: { total: 2, hasMore: false, cursor: "b5", items: [{ id: "b2" }, { id: "b5" }] } } },
        { id: "b3", title: "Invisible Cities", author: { name: "Italo Calvino", books: { total: 2, hasMore: false, cursor: "b7", items: [{ id: "b3" }, { id: "b7" }] } } },
      ],
    });
    // the same screen the per-level loaders serve in three statements, in one
    expect(log).toHaveLength(1);
  });

  it("a resolver that hands the op's shape to screen serves the whole request in one statement, through the runtime", async () => {
    const { server } = bookstore(counted, { screen: true });
    const shape = "{ total hasMore cursor items { id heading: title author { name byline: name books(page: { first: 1 }) { total items { id } } } } }";
    const frames = await server.collect({ ops: [{ id: 1, op: "books", args: { page: { first: 2 } }, shape }] });
    expect(frames).toEqual([
      {
        id: 1,
        data: {
          total: 7,
          hasMore: true,
          cursor: "b2",
          items: [
            { $type: "Book", id: "b1", heading: "The Dispossessed", author: { $type: "Author", name: "Ursula K. Le Guin", byline: "Ursula K. Le Guin", books: { total: 3, items: [{ $type: "Book", id: "b1" }] } } },
            { $type: "Book", id: "b2", heading: "Kindred", author: { $type: "Author", name: "Octavia E. Butler", byline: "Octavia E. Butler", books: { total: 2, items: [{ $type: "Book", id: "b2" }] } } },
          ],
        },
        meta: { cost: 12 },
        fin: true,
      },
    ]);
    expect(log).toHaveLength(1);
  });

  it("guard: screen refuses one field selected twice in different ways, since both aliases would get one value", async () => {
    const { store } = bookstore(counted);
    const twice = parseShapeText("{ id author { few: books(page: { first: 1 }) { items { id } } more: books(page: { first: 2 }) { items { id } } } }");
    await expect(store.screen("Book", twice, { first: 1 })).rejects.toThrow("@rayfold/postgres: a screen selects Author.books twice with different arguments or fields");
    expect(log).toEqual([]);
  });
  it("through the runtime, screen pushes the caller's read policy into its statement; an admin gets every row", async () => {
    const { server } = bookstore(counted, { screen: true });
    const shape = "{ total items { id customerId } }";
    const [mine] = await server.collect({ ops: [{ id: 1, op: "ordersPage", shape }] }, { viewer: { id: "u1", role: "customer" } });
    expect(mine).toMatchObject({ data: { total: 2, items: [{ id: "o1", customerId: "u1" }, { id: "o3", customerId: "u1" }] } });
    expect([log.length, fetched()]).toEqual([1, 2]);
    log.length = 0;
    const [all] = await server.collect({ ops: [{ id: 1, op: "ordersPage", shape }] }, { viewer: { id: "u9", role: "admin" } });
    expect((all as { data: { items: Array<{ id: string }> } }).data.items.map((o) => o.id)).toEqual(["o1", "o2", "o3", "o4"]);
    expect([log.length, fetched()]).toEqual([1, 4]);
  });

  it("pushes each level's read policy into the one statement, and keeps paging from a cursor", async () => {
    const { store } = bookstore(counted);
    const mine = await store.screen("Order", parseShapeText("{ id total }"), { first: 10 }, {}, { viewer: { id: "u1" } });
    expect(mine.items.map((o) => o["id"])).toEqual(["o1", "o3"]); // never o2, never the unowned o4
    expect(mine.total).toBe(2);
    expect(log).toHaveLength(1);

    const admin = await store.screen("Order", parseShapeText("{ id }"), { first: 10 }, {}, { viewer: { id: "u9", role: "admin" } });
    expect(admin.items.map((o) => o["id"])).toEqual(["o1", "o2", "o3", "o4"]); // guard: the rule is not a blanket refusal

    const second = await store.screen("Book", parseShapeText("{ id }"), { first: 3, after: "b3" });
    expect(second.items.map((b) => b["id"])).toEqual(["b4", "b5", "b6"]);
    expect(second).toEqual({ items: [{ id: "b4" }, { id: "b5" }, { id: "b6" }], total: 7, hasMore: true, cursor: "b6" });
    const last = await store.screen("Book", parseShapeText("{ id }"), { first: 3, after: "b7" });
    expect(last).toEqual({ items: [], total: 7, hasMore: false, cursor: null });
  });

  it("walks every page with the cursor: no duplicate, no gap, the total on each page, and an empty page after the last", async () => {
    const { store } = bookstore(counted);
    const seen: string[] = [];
    let after: string | null = null;
    for (let i = 0; i < 10; i++) {
      const p = await store.page("Book", { first: 3, after });
      expect(p.total).toBe(7);
      seen.push(...p.items.map((b) => String(b["id"])));
      if (!p.hasMore) break;
      after = p.cursor;
    }
    expect(seen).toEqual(["b1", "b2", "b3", "b4", "b5", "b6", "b7"]);
    expect(await store.page("Book", { first: 3, after: "b7" })).toEqual({ items: [], cursor: null, hasMore: false, total: 7 });
    expect(await store.page("Book", { first: 0 })).toEqual({ items: [], cursor: null, hasMore: true, total: 7 });
  });

  it("a page that holds exactly the rows left has no more, through page and screen alike (guard - one row short has more)", async () => {
    const { store } = bookstore(counted);
    const ids = (p: { items: Row[] }) => p.items.map((b) => b["id"]);
    const all = await store.page("Book", { first: 7 });
    expect([ids(all), all.hasMore, all.cursor, all.total]).toEqual([["b1", "b2", "b3", "b4", "b5", "b6", "b7"], false, "b7", 7]);
    expect((await store.page("Book", { first: 6 })).hasMore).toBe(true);
    expect(await store.screen("Book", parseShapeText("{ id }"), { first: 2, after: "b5" })).toEqual({ items: [{ id: "b6" }, { id: "b7" }], cursor: "b7", hasMore: false, total: 7 });
    expect((await store.screen("Book", parseShapeText("{ id }"), { first: 1, after: "b5" })).hasMore).toBe(true);
    // one row past the page is all it takes to know there is more: page and screen fetch first + 1, never the rest
    log = [];
    await store.page("Book", { first: 2 });
    await store.screen("Book", parseShapeText("{ id }"), { first: 2 });
    expect(log.map((l) => l.rows)).toEqual([3, 3]);
  });

  it("screen called without a pushed-down policy applies the type's own, in the count after the last page too", async () => {
    const { store } = bookstore(counted);
    expect(await store.screen("Order", parseShapeText("{ id }"), { first: 10, after: "o9" }, {}, { viewer: { id: "u1" } })).toEqual({ items: [], cursor: null, hasMore: false, total: 2 });
    // guard: an admin's count is every order
    expect((await store.screen("Order", parseShapeText("{ id }"), { first: 10, after: "o9" }, {}, { viewer: { id: "u9", role: "admin" } })).total).toBe(4);
  });

  it("a nested page of a parent with no rows is empty, with nothing more and no cursor", async () => {
    await db.exec(`INSERT INTO authors VALUES ('a4', 'Nobody Yet')`);
    const { store } = bookstore(counted);
    expect(await store.screen("Author", parseShapeText("{ id books { items { id } total hasMore cursor } }"), { first: 10, after: "a2" })).toEqual({
      items: [
        { id: "a3", books: { items: [{ id: "b3" }, { id: "b7" }], total: 2, hasMore: false, cursor: "b7" } },
        { id: "a4", books: { items: [], total: 0, hasMore: false, cursor: null } },
      ],
      cursor: "a4",
      hasMore: false,
      total: 4,
    });
  });

  it("a screen nests at most nine levels, root included, and says so at the tenth", async () => {
    const { store } = bookstore(counted);
    // each author { books } pair is two levels below the book it starts from; `tail` adds one more
    const levels = (n: number, tail = "") => "{ id " + "author { id books { items { id ".repeat(n) + tail + "}".repeat(3 * n) + " }";
    expect((await store.screen("Book", parseShapeText(levels(4)), { first: 1 })).items).toHaveLength(1);
    await expect(store.screen("Book", parseShapeText(levels(4, " author { id }")), { first: 1 })).rejects.toThrow(/^@rayfold\/postgres: a screen nested deeper than 8 levels$/);
  });

  it("a relation keyed by a field its type does not have is refused by name", async () => {
    const { ir } = loadSchema(SCHEMA);
    const store = createPgStore(counted, { ir, naming: "snake", tables: { Author: { table: "authors", relations: { books: { type: "Book", kind: "page", key: "writer" } } }, Book: { table: "books" } } });
    await expect(store.screen("Author", parseShapeText("{ id books { items { id } } }"), { first: 1 })).rejects.toThrow(/^@rayfold\/postgres: Book has no field writer$/);
    expect(log).toEqual([]);
  });

  it("loads by id in the order asked, with null for a missing id, in one query", async () => {
    const { store } = bookstore(counted);
    const rows = await store.byIds("Book", ["b3", "nope", "b1", "b3", null]);
    expect(rows.map((r) => r?.["title"] ?? null)).toEqual(["Invisible Cities", null, "The Dispossessed", "Invisible Cities", null]);
    expect(rows[0]).toMatchObject({ authorId: "a3", stock: 0 });
    expect(log).toHaveLength(1);
  });

  it("find, page and screen keep only the rows `where` names: a value by parameter, null as IS NULL", async () => {
    const { store } = bookstore(counted);
    const ids = (rows: Row[]) => rows.map((r) => r["id"]);
    expect(ids(await store.find("Book", { authorId: "a1" }))).toEqual(["b1", "b4", "b6"]);
    expect(ids(await store.find("Book", { authorId: "a1", stock: 4 }))).toEqual(["b4"]);
    expect(ids(await store.find("Order", { customerId: null }))).toEqual(["o4"]);

    const first = await store.page("Book", { first: 2 }, { authorId: "a1" });
    expect([ids(first.items), first.cursor, first.hasMore, first.total]).toEqual([["b1", "b4"], "b4", true, 3]);
    const rest = await store.page("Book", { first: 2, after: "b4" }, { authorId: "a1" });
    expect([ids(rest.items), rest.cursor, rest.hasMore, rest.total]).toEqual([["b6"], "b6", false, 3]);
    // past the last row the total comes from a second count, which must filter the same way
    expect(await store.page("Book", { first: 2, after: "b6" }, { authorId: "a1" })).toEqual({ items: [], cursor: null, hasMore: false, total: 3 });

    const shape = parseShapeText("{ id title }");
    expect(await store.screen("Book", shape, { first: 5 }, { authorId: "a2" })).toEqual({
      items: [{ id: "b2", title: "Kindred" }, { id: "b5", title: "Dawn" }],
      cursor: "b5",
      hasMore: false,
      total: 2,
    });
    expect(await store.screen("Book", shape, { first: 5, after: "b5" }, { authorId: "a2" })).toEqual({ items: [], cursor: null, hasMore: false, total: 2 });
    // `where` and the pushed-down read policy in one statement: u1 may not see the order without a customer, an admin may
    expect((await store.screen("Order", parseShapeText("{ id }"), { first: 5 }, { customerId: null }, { viewer: { id: "u1" } })).total).toBe(0);
    expect(await store.screen("Order", parseShapeText("{ id }"), { first: 5 }, { customerId: null }, { viewer: { id: "u9", role: "admin" } })).toEqual({
      // customerId goes along because the type's read rule reads it; the runtime leaves it out of what it sends
      items: [{ id: "o4", customerId: null }],
      cursor: "o4",
      hasMore: false,
      total: 1,
    });
  });

  it("guard: a `where` on a field the type does not have is refused before any statement is sent", async () => {
    const { store } = bookstore(counted);
    const refusal = "@rayfold/postgres: Book has no field colour";
    await expect(store.find("Book", { colour: "red" })).rejects.toThrow(refusal);
    await expect(store.page("Book", { first: 2 }, { colour: "red" })).rejects.toThrow(refusal);
    await expect(store.screen("Book", parseShapeText("{ id }"), { first: 2 }, { colour: "red" })).rejects.toThrow(refusal);
    expect(log).toEqual([]);
  });

  it("pagesByField pages every parent's rows from one cursor, with each parent's total over all its rows", async () => {
    const { store } = bookstore(counted);
    const pages = await store.pagesByField("Book", "authorId", ["a1", "a2", "a3", "a9"], { first: 1, after: "b2" });
    expect(pages.map((p) => [p.items.map((b) => b["id"]), p.cursor, p.hasMore, p.total])).toEqual([
      [["b4"], "b4", true, 3],
      [["b5"], "b5", false, 2],
      [["b3"], "b3", true, 2],
      [[], null, false, 0],
    ]);
    expect(log).toHaveLength(1);
  });
});

describe("read policies pushed into SQL (spec 06 §4)", () => {
  const run = async (server: RayfoldServer, op: string, viewer: unknown, shape = "{ id }") => {
    log.length = 0;
    const [f] = await server.collect({ ops: [{ id: 1, op, shape }] }, { viewer });
    return f as Record<string, unknown>;
  };

  it("a customer's list holds only their orders, and SQL fetched only those; an admin sees every order", async () => {
    const { server } = bookstore(counted);
    expect(await run(server, "orders", { id: "u1", role: "customer" }, "{ id customerId }")).toMatchObject({ data: [{ id: "o1", customerId: "u1" }, { id: "o3", customerId: "u1" }] });
    expect(fetched()).toBe(2);
    expect(((await run(server, "orders", { id: "u9", role: "admin" })) as { data: unknown[] }).data).toHaveLength(4);
    expect(fetched()).toBe(4);
  });

  it("with nobody signed in, the order without a customer is the one visible, in SQL exactly as in the runtime", async () => {
    const { server } = bookstore(counted);
    expect(await run(server, "orders", null)).toMatchObject({ data: [{ id: "o4" }] });
    expect(fetched()).toBe(1);
    // null equals null in a policy, so the runtime allows it too; the pushdown mirrors it rather than second-guessing it
    const order = loadSchema(SCHEMA).ir.types["Order"]!;
    expect(decide(order.annotations, "read", { viewer: null, args: {}, this: { customerId: null } })).toBe("allow");
  });

  it("guard: a resolver that ignores the pushed-down policy fetches every row, and the runtime refuses the list", async () => {
    const { server } = bookstore(counted);
    expect(await run(server, "ordersUnfiltered", { id: "u1", role: "customer" })).toMatchObject({ error: { code: "permission_denied" } });
    expect(fetched()).toBe(4);
  });

  it("a field on the right of `in` is left to the runtime: its negation keeps every row, as the policy does", async () => {
    const schema = `
      entity NotListed @allow(read: !(["u1"] in customerId)) { id: ID customerId: ID? }
      entity NotU1 @allow(read: !(customerId in ["u1"])) { id: ID customerId: ID? }
      query notListed: [NotListed]
      query notU1: [NotU1]
    `;
    const store = createPgStore(counted, { ir: loadSchema(schema).ir, naming: "snake", tables: { NotListed: { table: "order" }, NotU1: { table: "order" } } });
    const server = createRayfoldServer({
      schema,
      resolvers: { Query: { notListed: (_a, ctx) => store.find("NotListed", {}, ctx), notU1: (_a, ctx) => store.find("NotU1", {}, ctx) } },
    });
    // `["u1"] in customerId` is false for every row (a list is never an element of an ID), so every order is allowed
    expect((await run(server, "notListed", { id: "u1" })).data).toEqual([{ $type: "NotListed", id: "o1" }, { $type: "NotListed", id: "o2" }, { $type: "NotListed", id: "o3" }, { $type: "NotListed", id: "o4" }]);
    expect(fetched()).toBe(4);
    // guard: with the field on the left, `in` is still pushed down exactly, so SQL fetched only the rows allowed
    expect((await run(server, "notU1", { id: "u1" })).data).toEqual([{ $type: "NotU1", id: "o2" }, { $type: "NotU1", id: "o4" }]);
    expect(fetched()).toBe(2);
  });

  it("a page's total counts only the rows the viewer may see", async () => {
    const { server } = bookstore(counted);
    expect(await run(server, "ordersPage", { id: "u1", role: "customer" }, "{ total items { id } }")).toMatchObject({ data: { total: 2, items: [{ id: "o1" }, { id: "o3" }] } });
  });

  it("values travel as parameters: a hostile viewer id matches nothing and leaves the tables as they were", async () => {
    const { server } = bookstore(counted);
    expect(await run(server, "orders", { id: "x' OR '1'='1", role: "customer" })).toMatchObject({ data: [] });
    expect(await run(server, "orders", { id: "u2'; DROP TABLE \"order\"; --", role: "customer" })).toMatchObject({ data: [] });
    expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "order"`)).rows[0]?.n).toBe(4);
  });

  it("never drops a row the policy allows, for every policy, viewer and row, and selects exactly those when it says exact", async () => {
    await db.exec(`
      CREATE TABLE p (id text PRIMARY KEY, customer_id text, total numeric(10, 2), qty int, archived boolean);
      INSERT INTO p VALUES
        ('r1', 'u1', 12.50, 5, false), ('r2', 'u2', 8.00, 1, true), ('r3', NULL, 12.50, NULL, NULL), ('r4', '7', 0, 3, false),
        ('r5', '007', 99.99, 10, true), ('r6', 'u1', NULL, 0, NULL);
    `);
    const columns: Record<string, PolicyColumn> = {
      customerId: { column: `"customer_id"`, scalar: "ID" },
      total: { column: `"total"`, scalar: "Decimal" },
      qty: { column: `"qty"`, scalar: "Int" },
      archived: { column: `"archived"`, scalar: "Boolean" },
    };
    const policies = [
      "viewer.id == customerId",
      "customerId != viewer.id",
      "!(customerId == viewer.id)",
      "customerId in viewer.teams",
      `viewer.role == "admin" || customerId == viewer.id`,
      `customerId == "7"`,
      `!(customerId == "7")`,
      "!(total == viewer.limit)",
      "total == viewer.limit",
      "total != viewer.limit",
      "qty > viewer.min",
      "viewer.min <= qty",
      "!(qty > viewer.min)",
      "qty == viewer.min",
      "archived",
      "!archived",
      "archived == false && qty >= 3",
      `qty == "5"`,
      "has(viewer.teams, customerId)",
      // the other side reads the row too, though it is no plain field: only the runtime can decide it
      "archived == (!archived)",
    ];
    const viewers = [null, { id: "u1" }, { id: "7" }, { id: "007", teams: ["u1", "7"] }, { role: "admin" }, { id: "u2", limit: "12.50", min: 3 }, { limit: 12.5, min: 2.5 }];
    const rows = (await db.query<Row>("SELECT * FROM p ORDER BY id")).rows.map((r) => ({ id: r["id"], customerId: r["customer_id"], total: r["total"], qty: r["qty"], archived: r["archived"] }));
    let exact = 0;
    let loose = 0;
    for (const text of policies) {
      const policy = parseExprText(text, "this");
      for (const viewer of viewers) {
        const env: ExprEnv = { viewer, args: {}, this: null };
        const allowed = rows.filter((r) => {
          try {
            const v = evalExpr(policy, { ...env, this: r });
            return v !== null && v !== undefined && v !== false;
          } catch {
            return false; // an expression that cannot be evaluated denies
          }
        }).map((r) => r.id);
        const params: unknown[] = [];
        const f = compilePolicy(policy, env, (name) => columns[name], params);
        const selected = (await db.query<{ id: string }>(`SELECT id FROM p WHERE ${f.sql} ORDER BY id`, params)).rows.map((r) => r.id);
        const label = `${text} for ${JSON.stringify(viewer)}: SQL ${f.sql}`;
        expect(selected, label).toEqual(expect.arrayContaining(allowed));
        if (f.exact) {
          expect(selected, label).toEqual(allowed);
          exact++;
        } else loose++;
      }
    }
    // how many of the 140 cases translate exactly is part of what is under test: a translation that turned loose
    // still passes every row check above, and only reads more rows than it should
    expect({ exact, loose }, "most cases translate exactly; the cases SQL cannot match exactly are left to the runtime").toEqual({ exact: 98, loose: 42 });
  });
});

const CALENDAR = `
entity Cal { id: ID evs(page: PageArgs = { first: 5 }): Page<Ev> }
entity Ev { id: ID calId: ID day: Date at: Instant }
query ev(id: ID): Ev?
query evs: [Ev]
query evPage(page: PageArgs = { first: 5 }): Page<Ev>
query evScreen(page: PageArgs = { first: 5 }): Page<Ev>
query cals: [Cal]
`;

/** The calendar through every read of the store, each behind the resolver that serves it, run by a real server. */
async function calendarDays(sql: Queryable, tables: { cal: string; ev: string }): Promise<unknown[]> {
  const { ir } = loadSchema(CALENDAR);
  const store = createPgStore(sql, { ir, naming: "snake", tables: { Cal: { table: tables.cal }, Ev: { table: tables.ev } } });
  const server = createRayfoldServer({
    schema: CALENDAR,
    resolvers: {
      Query: {
        ev: async (a: { id: string }, ctx) => (await store.byIds("Ev", [a.id], ctx))[0],
        evs: (_a, ctx) => store.find("Ev", {}, ctx),
        evPage: (a: { page: PageRequest }, ctx) => store.page("Ev", a.page, {}, ctx),
        evScreen: (a: { page: PageRequest }, ctx) => store.screen("Ev", ctx.shape!, a.page, {}, ctx),
        cals: (_a, ctx) => store.find("Cal", {}, ctx),
      },
      Cal: { evs: (parents: Row[], a: { page: PageRequest }, ctx: RayfoldContext) => store.pagesByField("Ev", "calId", parents.map((p) => p["id"]), a.page, ctx) },
    },
  });
  const shape = "{ id day at }";
  const frames = await server.collect({
    ops: [
      { id: 1, op: "ev", args: { id: "e1" }, shape },
      { id: 2, op: "evs", shape },
      { id: 3, op: "evPage", shape: `{ items ${shape} }` },
      { id: 4, op: "evScreen", shape: `{ items ${shape} }` },
      { id: 5, op: "cals", shape: `{ evs { items ${shape} } }` },
    ],
  });
  // the ops run at once, and on a pool they finish in any order
  const byId = (frames as Array<{ id: number; data?: unknown; error?: unknown }>).sort((a, b) => a.id - b.id);
  return byId.map((f) => f.data ?? f.error);
}

const E1 = { $type: "Ev", id: "e1", day: "2024-01-01", at: "2024-01-01T12:00:00.000Z" };
const E2 = { $type: "Ev", id: "e2", day: "2024-06-30", at: "2024-06-30T23:30:00.000Z" };
const EVERY_PATH = [E1, [E1, E2], { items: [E1, E2] }, { items: [E1, E2] }, [{ $type: "Cal", evs: { items: [E1, E2] } }]];

/** Runs `f` with the process in Tokyo, east of UTC, where a local midnight is still the day before in UTC. */
async function inTokyo<T>(f: () => Promise<T>): Promise<T> {
  const before = process.env["TZ"];
  process.env["TZ"] = "Asia/Tokyo";
  try {
    expect(new Date(2024, 0, 1).getTimezoneOffset(), "the process time zone took").toBe(-540);
    return await f();
  } finally {
    if (before === undefined) delete process.env["TZ"];
    else process.env["TZ"] = before;
  }
}

const calendarRows = (cal: string, ev: string) => `
  CREATE TABLE ${cal} (id text PRIMARY KEY);
  CREATE TABLE ${ev} (id text PRIMARY KEY, cal_id text NOT NULL, day date NOT NULL, at timestamptz NOT NULL);
  INSERT INTO ${cal} VALUES ('c1');
  INSERT INTO ${ev} VALUES ('e1', 'c1', '2024-01-01', '2024-01-01T12:00:00Z'), ('e2', 'c1', '2024-06-30', '2024-06-30T23:30:00Z');
`;

describe("a Date reads as its day and an Instant as UTC, the same through every path", () => {
  it("on PGlite with the session and the process east of UTC: byIds, find, page, screen and pagesByField agree", async () => {
    await db.exec(calendarRows("cal", "ev"));
    // Postgres writes a timestamptz into JSON in the session's zone; screen used to hand that on, "+09:00" and all
    await db.exec("SET TimeZone = 'Asia/Tokyo'");
    expect(await inTokyo(() => calendarDays(counted, { cal: "cal", ev: "ev" }))).toEqual(EVERY_PATH);
  });

  it.skipIf(!process.env["DATABASE_URL"])("on a real Postgres through pg, whose date is a local midnight, in a process and session east of UTC", async () => {
    const pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"], options: "-c TimeZone=Asia/Tokyo" });
    const cal = `rayfold_cal_${process.pid}`;
    const ev = `rayfold_ev_${process.pid}`;
    const sql: Queryable = { query: async (text, params) => (await pool.query(text, params as unknown[])) as never };
    try {
      await pool.query(calendarRows(cal, ev));
      // pg made 2024-01-01 the JS Date for midnight in Tokyo, which the runtime wrote as 2023-12-31
      expect(await inTokyo(() => calendarDays(sql, { cal, ev }))).toEqual(EVERY_PATH);
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${cal}, ${ev}`);
      await pool.end();
    }
  });
});

describe("screen", () => {
  it("serves a level selecting more than fifty fields, past Postgres's hundred arguments to one function", async () => {
    const fields = Array.from({ length: 60 }, (_, i) => `f${i}`);
    const schema = `entity Wide { id: ID ${fields.map((f) => `${f}: Int`).join(" ")} }\nquery wides(page: PageArgs = { first: 5 }): Page<Wide>`;
    await db.exec(`CREATE TABLE wide (id text PRIMARY KEY, ${fields.map((f) => `${f} int`).join(", ")}); INSERT INTO wide VALUES ('w1', ${fields.map((_, i) => i).join(", ")})`);
    const store = createPgStore(counted, { ir: loadSchema(schema).ir, tables: { Wide: { table: "wide" } } });
    const server = createRayfoldServer({ schema, resolvers: { Query: { wides: (a: { page: PageRequest }, ctx) => store.screen("Wide", ctx.shape!, a.page, {}, ctx) } } });
    const [f] = await server.collect({ ops: [{ id: 1, op: "wides", shape: `{ total items { id ${fields.join(" ")} } }` }] });
    expect((f as { data: unknown }).data).toEqual({ total: 1, items: [{ $type: "Wide", id: "w1", ...Object.fromEntries(fields.map((f, i) => [f, i])) }] });
    expect(log).toHaveLength(1);
  });

  const AUTHORS = `
entity Author { id: ID name: String books(page: PageArgs = { first: 2 }): Page<Book> }
entity Book { id: ID title: String authorId: ID }
query authors(page: PageArgs = { first: 5 }): Page<Author>
`;
  const authors = async (shape: string, vars?: Record<string, number>) => {
    const store = createPgStore(counted, {
      ir: loadSchema(AUTHORS).ir,
      naming: "snake",
      tables: { Author: { table: "authors", relations: { books: { type: "Book", kind: "page", key: "authorId" } } }, Book: { table: "books" } },
    });
    const server = createRayfoldServer({ schema: AUTHORS, resolvers: { Query: { authors: (a: { page: PageRequest }, ctx) => store.screen("Author", ctx.shape!, a.page, {}, ctx) } } });
    const [f] = await server.collect({ ops: [{ id: 1, op: "authors", shape, ...(vars ? { vars } : {}) }] });
    const items = (f as { data: { items: Array<{ id: string; books: { total?: number; hasMore: boolean; items: Array<{ id: string }> } }> } }).data.items;
    return items.map((a) => [a.id, a.books.items.map((b) => b.id), a.books.hasMore, a.books.total]);
  };

  it("a nested page selected without arguments takes the field's declared default, and one given by a variable takes it", async () => {
    // the field says first: 2; the store used to take 10, and handed a1 all three of its books
    expect(await authors("{ items { id books { total hasMore items { id } } } }")).toEqual([
      ["a1", ["b1", "b4"], true, 3],
      ["a2", ["b2", "b5"], false, 2],
      ["a3", ["b3", "b7"], false, 2],
    ]);
    expect(await authors("{ items { id books(page: { first: $n }) { total hasMore items { id } } } }", { n: 1 })).toEqual([
      ["a1", ["b1"], true, 3],
      ["a2", ["b2"], true, 2],
      ["a3", ["b3"], true, 2],
    ]);
  });

  it("guard: a nested page given its size in the shape takes that size, above the default as below it", async () => {
    expect(await authors("{ items { id books(page: { first: 3 }) { total hasMore items { id } } } }")).toEqual([
      ["a1", ["b1", "b4", "b6"], false, 3],
      ["a2", ["b2", "b5"], false, 2],
      ["a3", ["b3", "b7"], false, 2],
    ]);
  });
});

describe("screen and the read rules of what it returns", () => {
  // the rules read fields the shape does not ask for: the store pushes them into SQL, and the runtime checks them again
  // on every row it gets, so a row that left those fields out read as refused
  const NOTES = `
entity Author @allow(read: this.deleted == false) { id: ID name: String deleted: Boolean notes(page: PageArgs = { first: 5 }): Page<Note> }
entity Note @allow(read: this.publishedAt != null) { id: ID title: String authorId: ID publishedAt: Instant? }
query authors(page: PageArgs = { first: 5 }): Page<Author>
`;
  const notes = async (shape: string) => {
    await db.exec(`
      CREATE TABLE writers (id text PRIMARY KEY, name text, deleted boolean);
      CREATE TABLE notes (id text PRIMARY KEY, title text, author_id text, published_at timestamptz);
      INSERT INTO writers VALUES ('a1', 'Ada', false), ('a2', 'Bob', true);
      INSERT INTO notes VALUES ('n1', 'Out', 'a1', '2026-01-01T00:00:00Z'), ('n2', 'Draft', 'a1', NULL), ('n3', 'Hidden', 'a2', '2026-01-01T00:00:00Z');
    `);
    const store = createPgStore(counted, {
      ir: loadSchema(NOTES).ir,
      naming: "snake",
      tables: { Author: { table: "writers", relations: { notes: { type: "Note", kind: "page", key: "authorId" } } }, Note: { table: "notes" } },
    });
    const server = createRayfoldServer({ schema: NOTES, resolvers: { Query: { authors: (a: { page: PageRequest }, ctx) => store.screen("Author", ctx.shape!, a.page, {}, ctx) } } });
    const [f] = await server.collect({ ops: [{ id: 1, op: "authors", shape }] });
    return f;
  };

  it("returns the rows the rules allow, though the shape selects none of the fields the rules read", async () => {
    expect(await notes("{ total items { id name notes { total items { id title } } } }")).toEqual({
      id: 1,
      data: {
        total: 1,
        items: [{ $type: "Author", id: "a1", name: "Ada", notes: { total: 1, items: [{ $type: "Note", id: "n1", title: "Out" }] } }],
      },
      meta: { cost: 42 },
      fin: true,
    });
    expect(log).toHaveLength(1);
  });

  it("guard: the fields a rule reads are not added to what the caller gets back, and a shape that asks for them still has them", async () => {
    expect(await notes("{ items { id deleted notes { items { id publishedAt } } } }")).toEqual({
      id: 1,
      data: { items: [{ $type: "Author", id: "a1", deleted: false, notes: { items: [{ $type: "Note", id: "n1", publishedAt: "2026-01-01T00:00:00.000Z" }] } }] },
      meta: { cost: 42 },
      fin: true,
    });
  });
});

describe("screen reads a rule's field as the wire carries it", () => {
  it("an Instant a rule compares, though the shape does not select it, reads as the runtime's ISO text (guard - another instant is still refused)", async () => {
    const LOG = `entity Entry @allow(read: this.at == "2026-01-01T00:00:00.000Z") { id: ID note: String at: Instant } query entries(page: PageArgs = { first: 5 }): Page<Entry>`;
    await db.exec(`CREATE TABLE entries (id text PRIMARY KEY, note text, at timestamptz); INSERT INTO entries VALUES ('e1', 'kept', '2026-01-01T00:00:00Z');`);
    const store = createPgStore(counted, { ir: loadSchema(LOG).ir, naming: "snake", tables: { Entry: { table: "entries" } } });
    const server = createRayfoldServer({ schema: LOG, resolvers: { Query: { entries: (a: { page: PageRequest }, ctx) => store.screen("Entry", ctx.shape!, a.page, {}, ctx) } } });
    const [f] = await server.collect({ ops: [{ id: 1, op: "entries", shape: "{ items { id note } }" }] });
    expect(f).toEqual({ id: 1, data: { items: [{ $type: "Entry", id: "e1", note: "kept" }] }, meta: { cost: 7 }, fin: true });
    // guard: the rule still refuses: a row at another instant fails the list, as the runtime refuses any row it may not show
    await db.exec(`INSERT INTO entries VALUES ('e2', 'later', '2026-02-01T00:00:00Z')`);
    const [refused] = await server.collect({ ops: [{ id: 1, op: "entries", shape: "{ items { id note } }" }] });
    expect(refused).toEqual({ id: 1, error: { code: "permission_denied", message: "Not allowed to access Entry at items.1", path: "items.1" }, fin: true });
  });
});

describe("pagesByField through the runtime", () => {
  const SHELF = `
entity Author { id: ID books(page: PageArgs = { first: 10 }): Page<Book> }
entity Book { id: ID authorId: ID }
query authors: [Author]
`;
  const shelf = async (page: string) => {
    const store = createPgStore(counted, { ir: loadSchema(SHELF).ir, naming: "snake", tables: { Author: { table: "authors" }, Book: { table: "books" } } });
    const server = createRayfoldServer({
      schema: SHELF,
      resolvers: {
        Query: { authors: (_a, ctx) => store.find("Author", {}, ctx) },
        Author: { books: (parents: Row[], a: { page: PageRequest }, ctx: RayfoldContext) => store.pagesByField("Book", "authorId", parents.map((p) => p["id"]), a.page, ctx) },
      },
    });
    const [f] = await server.collect({ ops: [{ id: 1, op: "authors", shape: `{ id books(page: ${page}) { total hasMore cursor items { id } } }` }] });
    type Books = { total: number; hasMore: boolean; cursor: string | null; items: Array<{ id: string }> };
    return (f as { data: Array<{ id: string; books: Books }> }).data.map((a) => [a.id, a.books.items.map((b) => b.id), a.books.cursor, a.books.hasMore, a.books.total]);
  };

  it("an author whose books all come before the cursor keeps its total, as page() does", async () => {
    // a2 has b2 and b5, neither after b5: it used to come back with a total of 0
    expect(await shelf(`{ first: 1, after: "b5" }`)).toEqual([
      ["a1", ["b6"], "b6", false, 3],
      ["a2", [], null, false, 2],
      ["a3", ["b7"], "b7", false, 2],
    ]);
  });

  it("fetches at most first + 1 rows of each author, where it fetched every book of every author", async () => {
    expect(await shelf("{ first: 1 }")).toEqual([
      ["a1", ["b1"], "b1", true, 3],
      ["a2", ["b2"], "b2", true, 2],
      ["a3", ["b3"], "b3", true, 2],
    ]);
    // the authors, then two books of each: a1's third stays in the database
    expect(log.map((l) => l.rows)).toEqual([3, 6]);
  });
});
