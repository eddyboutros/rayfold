import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Signal } from "../../../e2e/wait.ts";
import { createRayfoldServer, ok } from "@rayfold/server";
import { RayfoldClient } from "./client.ts";
import { createLocalTransport } from "./transport.ts";

/**
 * The invariant of spec 13 §8:
 *
 *     apply(every patch, in order, to the initial state)  ==  a fresh query of the final server state
 *
 * A live query is open throughout, so the client's copy is maintained only by the patches the server pushes, and at
 * the end it is compared against a fresh execution of the same query with the same shape.
 *
 * The first sequence this generated found a real defect, which the first test below is the shrunk reproduction of: a
 * command deleting an entity while a live query held a list containing it removed *two* rows from the client. `del`
 * is cache-wide and shortened the client's list; the positional `list del: [0]` that followed was computed against
 * the list the server had last sent, and took out whatever had moved into the slot. A deleted entity now leaves a
 * gap in the list instead, so positions keep lining up. See `Gone` in cache.ts.
 */
const runs = Number(process.env["FUZZ_RUNS"] ?? 30);
const params = { numRuns: runs, seed: process.env["FUZZ_SEED"] ? Number(process.env["FUZZ_SEED"]) : 20260917 };

const SCHEMA = `
  entity Book { id: ID title: String stock: Int }
  query books: [Book]
  command addBook(id: ID, title: String, stock: Int): Book
  command setStock(id: ID, stock: Int): Book?
  command removeBook(id: ID): Book?
`;
const SHAPE = { shape: "{ id title stock }" };
const viewer = { id: "u1" };

interface Row {
  id: string;
  title: string;
  stock: number;
}

/** A server whose whole state is one ordered list of books, and a client that follows it by patch alone. */
function build() {
  const books: Row[] = [
    { id: "b1", title: "Dune", stock: 3 },
    { id: "b2", title: "Emma", stock: 1 },
    { id: "b3", title: "Ubik", stock: 7 },
  ];
  const find = (id: string) => books.find((b) => b.id === id);

  const server = createRayfoldServer({
    schema: SCHEMA,
    resolvers: {
      Query: { books: () => books.map((b) => ({ ...b })) },
      Command: {
        addBook: ({ id, title, stock }: Row) => {
          const existing = find(id);
          if (existing) {
            existing.title = title;
            existing.stock = stock;
          } else books.push({ id, title, stock });
          return ok({ ...find(id)! });
        },
        setStock: ({ id, stock }: { id: string; stock: number }) => {
          const b = find(id);
          if (!b) return ok(null);
          b.stock = stock;
          return ok({ ...b });
        },
        // a removal has to say so: the row is gone, so the patch carries the `del` the client needs
        removeBook: ({ id }: { id: string }) => {
          const at = books.findIndex((b) => b.id === id);
          if (at < 0) return ok(null);
          books.splice(at, 1);
          return ok(null, { patch: [{ del: `Book:${id}` }] });
        },
      },
    },
  });
  const client = new RayfoldClient({ transport: createLocalTransport(server, () => viewer) });
  return { server, client, books };
}

/** What the server would answer right now, independent of anything the client believes. */
async function truth(server: ReturnType<typeof build>["server"]): Promise<Row[]> {
  const frames = await server.collect({ ops: [{ id: 1, op: "books", ...SHAPE }] }, { viewer });
  return (frames.find((f) => "data" in f) as { data: Row[] }).data;
}

const command = fc.oneof(
  fc.record({ op: fc.constant("addBook" as const), id: fc.constantFrom("b1", "b2", "b3", "b4", "b5"), title: fc.constantFrom("Dune", "Emma", "Ubik", "Solaris"), stock: fc.integer({ min: 0, max: 9 }) }),
  fc.record({ op: fc.constant("setStock" as const), id: fc.constantFrom("b1", "b2", "b3", "b4", "b5"), stock: fc.integer({ min: 0, max: 9 }) }),
  fc.record({ op: fc.constant("removeBook" as const), id: fc.constantFrom("b1", "b2", "b3", "b4", "b5") }),
);

describe("spec 13 §8: a client's copy equals a fresh query of the final state", () => {
  /** The shrunk sequence: one removal, which used to take the row after it as well. */
  it("a deletion under a live list removes exactly the row that went", async () => {
    const { server, client } = build();
    const seen = new Signal<string[]>();
    const stop = client.live<Row[]>("books", {}, SHAPE, (rows) => seen.push(rows.map((r) => r.id)));
    await seen.atLeast(1, "the live query answering");
    expect(seen.items[0]).toEqual(["b1", "b2", "b3"]);

    await client.command("removeBook", { id: "b1" }, { key: "0123456789abcdef" });
    await seen.atLeast(2, "the removal reaching the client");

    const held = seen.items[seen.items.length - 1]!;
    expect(held).toEqual((await truth(server)).map((r) => r.id));
    stop();
  });

  it("holds over generated sequences of adds, stock changes and removals", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(command, { minLength: 1, maxLength: 8 }), async (sequence) => {
        const { server, client, books } = build();
        const seen = new Signal<Row[]>();
        const stop = client.live<Row[]>("books", {}, SHAPE, (data) => seen.push(data));
        await seen.atLeast(1, "the live query answering");

        for (const [i, c] of sequence.entries()) {
          const args = c.op === "removeBook" ? { id: c.id } : c.op === "setStock" ? { id: c.id, stock: c.stock } : { id: c.id, title: c.title, stock: c.stock };
          await client.command(c.op, args, { key: `seq-${i}-${"0".repeat(10)}` });
        }

        // A barrier rather than a wait: frames for one operation arrive in order, so once the client has seen the
        // change this last command makes, every patch from the sequence above has already been applied.
        const sentinel = "zzz-sentinel";
        await client.command("addBook", { id: sentinel, title: "Sentinel", stock: 1 }, { key: `sentinel-${"0".repeat(8)}` });
        await seen.until((all) => all.some((rows) => rows.some((r) => r.id === sentinel)), "the sentinel reaching the client", 5_000);

        const held = seen.items[seen.items.length - 1]!;
        expect(held, `after ${JSON.stringify(sequence)}`).toEqual(await truth(server));
        expect(held.length, "the list is not empty").toBeGreaterThan(0);
        expect(books.length, "the server and the client agree on how many there are").toBe(held.length);

        stop();
        return true;
      }),
      params,
    );
  }, 120_000);
});
