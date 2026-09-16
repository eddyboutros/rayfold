/**
 * One member of a fleet: a Rayfold server over a Postgres database it shares with the other members, with the
 * idempotency records and the relay in that database and nothing in memory that another member would need.
 * `e2e/fleet.test.ts` starts two of these as separate processes against a real Postgres.
 *
 * Environment: DATABASE_URL, PORT, NAME (how this member signs the runs it records).
 */
import pg from "pg";
import { createRayfoldServer, listen, ok, shutdown, type RayfoldContext } from "@rayfold/server";
import { PgIdempotencyStore, PgRelay, pgNotifications } from "@rayfold/postgres";

const url = process.env["DATABASE_URL"];
const port = Number(process.env["PORT"]);
const name = process.env["NAME"] ?? "server";
if (!url || !port) throw new Error("DATABASE_URL and PORT are required");

const SCHEMA = `
  entity Book { id: ID stock: Int }
  event StockChanged { bookId: ID, stock: Int }
  query book(id: ID): Book?
  command restock(id: ID, qty: Int): Book emits StockChanged
  stream stockUpdates(bookIds: [ID]): StockChanged
`;

const pool = new pg.Pool({ connectionString: url });
const listener = new pg.Client({ connectionString: url }); // LISTEN belongs to one connection
await listener.connect();

// The application's own tables were migrated before this process started, as a deploy does. The stores create theirs
// here, on every member at once, which is how a fleet boots.
const idempotency = new PgIdempotencyStore(pool);
const relay = new PgRelay(pgNotifications(listener), pool);
await idempotency.migrate();
await relay.migrate();

interface Book {
  id: string;
  stock: number;
}

const server = createRayfoldServer({
  schema: SCHEMA,
  idempotency,
  relay,
  resolvers: {
    Query: {
      book: async ({ id }: { id: string }) => (await pool.query<Book>("SELECT id, stock FROM fleet_books WHERE id = $1", [id])).rows[0] ?? null,
    },
    Command: {
      restock: async ({ id, qty }: { id: string; qty: number }) => {
        // the command's own work takes long enough for a retry to arrive while it runs, which is what a duplicate
        // request looks like in production; the test asserts what happened, not how long it took
        await pool.query("SELECT pg_sleep(0.3)");
        await pool.query("INSERT INTO fleet_runs (server, book) VALUES ($1, $2)", [name, id]);
        const { rows } = await pool.query<Book>("UPDATE fleet_books SET stock = stock + $2 WHERE id = $1 RETURNING id, stock", [id, qty]);
        const book = rows[0];
        if (!book) throw new Error(`no book ${id}`);
        return ok(book, { emit: [{ event: "StockChanged", payload: { bookId: book.id, stock: book.stock } }] });
      },
    },
    Stream: {
      stockUpdates: (args: { bookIds: string[] }, ctx: RayfoldContext) => {
        const wanted = new Set(args.bookIds);
        const source = ctx.events.subscribe<{ bookId: string; stock: number }>("StockChanged", ctx.signal);
        return (async function* () {
          for await (const ev of source) if (wanted.has(ev.bookId)) yield ev;
        })();
      },
    },
  },
});

const http = await listen(server, port, {
  viewer: () => ({ id: "fleet" }),
  readiness: { db: () => pool.query("SELECT 1") },
});
await server.ready();

process.on("SIGTERM", () => {
  void shutdown(server, http, { timeoutMs: 5_000 }).then(async () => {
    await listener.end();
    await pool.end();
    process.exit(0);
  });
});

console.log(`${name} listening on ${port}`); // the test waits for this line
