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
  "  stock: Int @range(min: 5, max: 7)",
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

    expect(book["$type"]).toBe("Book");
    expect(typeof book["id"]).toBe("string");
    expect(typeof book["title"]).toBe("string");
    expect(typeof book["stock"]).toBe("number");
    expect(String(book["price"])).toMatch(/^[0-9]+[.][0-9]{2}$/); // a Decimal is text, and looks like one
    expect(book["author"]).toMatchObject({ $type: "Author", name: expect.any(String) });
  });

  it("honours an example, a range and the values an enum has", async () => {
    const ir = loadSchema(INLINE).ir;
    const book = resultOf((await mock(ir)([{ id: 1, op: "book", args: { id: "b1" } }]))[0]!);

    expect(book["title"]).toBe("Dune");
    expect(book["stock"]).toBeGreaterThanOrEqual(5);
    expect(book["stock"]).toBeLessThanOrEqual(7);
    expect(["HARDCOVER", "PAPERBACK", "EBOOK"]).toContain(book["format"]);
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
    expect((page["items"] as unknown[]).length).toBe(2);
    expect(page["hasMore"]).toBe(false);
    expect(page["total"]).toBe(2);

    const withReviews = resultOf(
      (await run([{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id reviews(page: { first: 3 }) { items { id rating } total } }" }]))[0]!,
    );
    const reviews = withReviews["reviews"] as { items: Array<Record<string, unknown>>; total: number };
    expect(reviews.items.length).toBe(3);
    expect(typeof reviews.items[0]?.["rating"]).toBe("number");
  });

  it("a command gives back what it was told", async () => {
    const ir = loadSchema(INLINE).ir;
    const frame = (await mock(ir)([{ id: 1, op: "rename", args: { id: "b7", title: "Neuromancer" }, key: "rename-0000000001" }]))[0]!;
    const book = resultOf(frame);
    expect(book["title"]).toBe("Neuromancer");
    expect(book["id"]).toBe("b7");
  });

  it("answers every operation the schema declares", async () => {
    const run = mock(bookstore);
    const queries = Object.values(bookstore.ops).filter((op) => op.kind === "query");
    expect(queries.length).toBeGreaterThan(3);
    for (const op of queries) {
      const args = Object.fromEntries(op.args.filter((a) => !a.type.nullable && a.default === undefined).map((a) => [a.name, "x1"]));
      const frame = (await run([{ id: 1, op: op.name, args }]))[0]!;
      expect((frame as unknown as Record<string, unknown>)["error"], `${op.name} failed`).toBeUndefined();
    }
  });
});
