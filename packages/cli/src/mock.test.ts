import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { loadSchema, type RayfoldSchemaIR } from "@rayfold/schema";
import { createRayfoldServer } from "@rayfold/server";
import type { Frame, RequestEnvelope } from "@rayfold/server";
import { mockResolvers } from "./mock.ts";

const bookstore = loadSchema(readFileSync(new URL("../../../examples/bookstore-ts/bookstore.rayfold", import.meta.url), "utf8")).ir;
const admin = { id: "u9", role: "admin" };

/** A server that only knows the schema, as `rayfold mock` builds it. */
function mock(ir: RayfoldSchemaIR) {
  const server = createRayfoldServer({ schema: ir, resolvers: mockResolvers(ir) });
  return async (ops: RequestEnvelope["ops"]): Promise<Frame[]> => server.collect({ ops }, { viewer: admin });
}

const resultOf = (frame: Frame): Record<string, unknown> => {
  const f = frame as unknown as Record<string, unknown>;
  expect(f["error"], JSON.stringify(f["error"])).toBeUndefined();
  return (f["data"] ?? f["ok"]) as Record<string, unknown>;
};

const INLINE = [
  "entity Book {",
  "  id: ID",
  '  title: String @example("Dune")',
  "  stock: Int @range(min: 50, max: 52)",
  "  format: Format",
  "}",
  "enum Format { HARDCOVER PAPERBACK EBOOK }",
  "query book(id: ID): Book?",
  "command rename(id: ID, title: String): Book",
].join("\n");

describe("a server that answers from the schema alone", () => {
  it("fills in the default view of a real schema, with values of the right kind", async () => {
    const run = mock(bookstore);
    const book = resultOf((await run([{ id: 1, op: "book", args: { id: "b1" } }]))[0]!);

    // the values come from the call's seed, so they are the same on every machine and every run
    expect(book).toEqual({
      $type: "Book",
      id: "book-728",
      title: "thistle meadow",
      format: "PAPERBACK",
      price: "46.73", // a Decimal is text, and looks like one
      stock: 5,
      author: { $type: "Author", id: "author-745", name: "quartz thistle" },
    });
  });

  it("honours an example, a range and the values an enum has", async () => {
    const ir = loadSchema(INLINE).ir;
    const book = resultOf((await mock(ir)([{ id: 1, op: "book", args: { id: "b1" } }]))[0]!);

    expect(book).toEqual({ $type: "Book", id: "book-728", title: "Dune", stock: 50, format: "PAPERBACK" });
  });

  it("gives the same answer to the same call, from a server it has never met", async () => {
    const call: RequestEnvelope["ops"] = [{ id: 1, op: "book", args: { id: "b1" } }];
    const first = resultOf((await mock(bookstore)(call))[0]!);
    const second = resultOf((await mock(bookstore)(call))[0]!);
    expect(second).toEqual(first);
  });

  it("guard - a different call gives a different answer", async () => {
    const run = mock(bookstore);
    const one = resultOf((await run([{ id: 1, op: "book", args: { id: "b1" } }]))[0]!);
    const other = resultOf((await run([{ id: 1, op: "book", args: { id: "b2" } }]))[0]!);
    expect(other["id"]).not.toEqual(one["id"]);
  });

  it("pages hold what the caller asked for, and a field with arguments is answered too", async () => {
    const run = mock(bookstore);
    const page = resultOf((await run([{ id: 1, op: "books", args: { page: { first: 2 } }, shape: "{ items { id title } hasMore total cursor }" }]))[0]!);
    expect(page).toEqual({
      items: [
        { $type: "Book", id: "book-743", title: "willow lantern" },
        { $type: "Book", id: "book-380", title: "cinder lantern" },
      ],
      hasMore: false,
      total: 2,
      cursor: "books:{page:{first:2}}:2",
    });

    const withReviews = resultOf(
      (await run([{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id reviews(page: { first: 3 }) { items { id rating } total } }" }]))[0]!,
    );
    expect(withReviews).toEqual({
      $type: "Book",
      id: "book-728",
      reviews: {
        items: [
          { $type: "Review", id: "review-229", rating: 5 },
          { $type: "Review", id: "review-584", rating: 5 },
          { $type: "Review", id: "review-522", rating: 5 },
        ],
        total: 3,
      },
    });
  });

  it("a command gives back what it was told", async () => {
    const ir = loadSchema(INLINE).ir;
    const frame = (await mock(ir)([{ id: 1, op: "rename", args: { id: "b7", title: "Neuromancer" }, key: "rename-0000000001" }]))[0]!;
    const book = resultOf(frame);
    expect(book["title"]).toBe("Neuromancer");
    expect(book["id"]).toBe("b7");
  });

  it("answers every operation the schema declares: queries, commands with a key, and streams to the end", async () => {
    const run = mock(bookstore);
    const calls: Record<string, Record<string, unknown>> = {
      books: {},
      book: { id: "b1" },
      author: { id: "a1" },
      review: { id: "r1" },
      order: { id: "o1" },
      myOrders: {},
      placeOrder: { input: { lines: [{ bookId: "b1", qty: 2 }] } },
      payOrder: { id: "o1" },
      cancelOrder: { id: "o1" },
      addReview: { input: { bookId: "b1", rating: 4, body: "Fine." } },
      editReview: { id: "r1", input: { rating: 5, body: "Better." } },
      updateBook: { id: "b1", patch: { title: "Dune" } },
      deleteReview: { id: "r1" },
      restock: { bookId: "b1", qty: 3 },
      stockUpdates: { bookIds: ["b1"] },
    };
    expect(Object.keys(calls).sort()).toEqual(Object.keys(bookstore.ops).sort());

    const answered: Record<string, string[]> = {};
    for (const op of Object.values(bookstore.ops)) {
      const key = op.kind === "command" ? { key: `${op.name}-key-0000000001` } : {};
      const frames = (await run([{ id: 1, op: op.name, args: calls[op.name]!, ...key }])) as unknown as Array<Record<string, unknown>>;
      answered[op.name] = frames.map((f) => (f["error"] ? `error ${JSON.stringify(f["error"])}` : Object.keys(f).filter((k) => ["data", "ok", "item", "fin"].includes(k)).join("+")));
    }
    expect(answered).toEqual({
      books: ["data+fin"],
      book: ["data+fin"],
      author: ["data+fin"],
      review: ["data+fin"],
      order: ["data+fin"],
      myOrders: ["data+fin"],
      placeOrder: ["ok+fin"],
      payOrder: ["ok+fin"],
      cancelOrder: ["ok+fin"],
      addReview: ["ok+fin"],
      editReview: ["ok+fin"],
      updateBook: ["ok+fin"],
      deleteReview: ["ok+fin"],
      restock: ["ok+fin"],
      stockUpdates: ["item", "item", "item", "fin"],
    });
  });

  it("a stream yields a page of made-up items, the same each time, then ends", async () => {
    const run = mock(bookstore);
    const frames = await run([{ id: 1, op: "stockUpdates", args: { bookIds: ["b1"] } }]);
    expect(frames).toEqual([
      { id: 1, item: { bookId: "stockUpdates-229", stock: 39 } },
      { id: 1, item: { bookId: "stockUpdates-734", stock: 22 } },
      { id: 1, item: { bookId: "stockUpdates-983", stock: 38 } },
      { id: 1, fin: true },
    ]);
  });
});
