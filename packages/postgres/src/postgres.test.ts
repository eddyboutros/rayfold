import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { evalExpr, loadSchema, parseExprText, parseShapeText, type ExprEnv } from "@rayfold/schema";
import { createRayfoldServer, decide, type RayfoldContext, type RayfoldServer } from "@rayfold/server";
import { compilePolicy, createPgStore, type PageRequest, type PgStore, type PolicyColumn, type Queryable, type Row } from "./index.ts";

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
    expect(f).toMatchObject({
      id: 1,
      fin: true,
      data: {
        total: 7,
        hasMore: true,
        cursor: "b3",
        items: [
          { id: "b1", title: "The Dispossessed", author: { name: "Ursula K. Le Guin", books: { total: 3, items: [{ id: "b1" }, { id: "b4" }] } } },
          { id: "b2", title: "Kindred", author: { name: "Octavia E. Butler", books: { total: 2, items: [{ id: "b2" }, { id: "b5" }] } } },
          { id: "b3", title: "Invisible Cities", author: { name: "Italo Calvino", books: { total: 2, items: [{ id: "b3" }, { id: "b7" }] } } },
        ],
      },
    });
    expect(log).toHaveLength(3);
  });

  it("serves the whole screen in one statement: the page, each book's author, and that author's own books", async () => {
    const { store } = bookstore(counted);
    const shape = parseShapeText("{ id title author { name books(page: { first: 2 }) { total items { id } } } }");
    const page = await store.screen("Book", shape, { first: 3 });
    expect(page).toMatchObject({
      total: 7,
      hasMore: true,
      cursor: "b3",
      items: [
        { id: "b1", title: "The Dispossessed", author: { name: "Ursula K. Le Guin", books: { total: 3, items: [{ id: "b1" }, { id: "b4" }] } } },
        { id: "b2", title: "Kindred", author: { name: "Octavia E. Butler", books: { total: 2, items: [{ id: "b2" }, { id: "b5" }] } } },
        { id: "b3", title: "Invisible Cities", author: { name: "Italo Calvino", books: { total: 2, items: [{ id: "b3" }, { id: "b7" }] } } },
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
    expect(second).toMatchObject({ total: 7, hasMore: true, cursor: "b6" });
    const last = await store.screen("Book", parseShapeText("{ id }"), { first: 3, after: "b7" });
    expect(last).toMatchObject({ items: [], total: 7, hasMore: false, cursor: null });
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

  it("loads by id in the order asked, with null for a missing id, in one query", async () => {
    const { store } = bookstore(counted);
    const rows = await store.byIds("Book", ["b3", "nope", "b1", "b3", null]);
    expect(rows.map((r) => r?.["title"] ?? null)).toEqual(["Invisible Cities", null, "The Dispossessed", "Invisible Cities", null]);
    expect(rows[0]).toMatchObject({ authorId: "a3", stock: 0 });
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
    expect(exact, "guard: most cases translate exactly").toBeGreaterThan(loose);
    expect(loose, "guard: the cases SQL cannot match exactly are left to the runtime").toBeGreaterThan(0);
  });
});
