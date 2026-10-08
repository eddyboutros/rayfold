/**
 * Every request the playground offers runs here through the same engine the page uses, so an example that stops
 * showing what its summary promises fails the build instead of confusing a visitor.
 */
import { RayfoldSchemaError, RayfoldSyntaxError } from "@rayfold/schema";
import type { Frame, RequestEnvelope } from "@rayfold/server/core";
import { describe, expect, it } from "vitest";
import { EXAMPLES, type Example, type ViewerName } from "./examples.ts";
import { BOOKSHOP_SCHEMA, createEngine, execute, kindOf, prepare, restock, sizes, type Engine } from "./engine.ts";

async function run(engine: Engine, request: Example["request"], viewer: ViewerName): Promise<Frame[]> {
  const frames: Frame[] = [];
  for await (const f of execute(engine, prepare(engine, request as RequestEnvelope), viewer)) frames.push(f);
  return frames;
}

const leGuin = { $type: "Author", name: "Ursula K. Le Guin" };
const outcomes: Record<string, (frames: Frame[]) => void> = {
  read: (f) => expect(f).toEqual([{ id: 1, data: { $type: "Book", title: "A Wizard of Earthsea", stock: 3, author: leGuin }, meta: { cost: 2 }, fin: true }]),
  "default-view": (f) => expect(f).toEqual([{ id: 1, data: { $type: "Book", id: "b3", title: "Dune", stock: 7 }, meta: { cost: 1 }, fin: true }]),
  page: (f) =>
    expect(f).toEqual([
      {
        id: 1,
        data: { items: [{ $type: "Book", title: "A Wizard of Earthsea", author: leGuin }, { $type: "Book", title: "The Left Hand of Darkness", author: leGuin }], cursor: "b2", hasMore: true, total: 3 },
        meta: { cost: 6 },
        fin: true,
      },
    ]),
  buy: (f) => {
    const book = { $type: "Book", id: "b1", title: "A Wizard of Earthsea", stock: 2 };
    expect(f).toEqual([{ id: 1, ok: book, patch: [{ set: "Book:b1", value: book }], meta: { cost: 1 }, fin: true }]);
  },
  "sold-out": (f) => expect(f).toEqual([{ id: 1, error: { code: "domain", message: "Only 0 left", type: "OutOfStock", data: { bookId: "b2", available: 0 } }, fin: true }]),
  pipeline: (f) => {
    const dune = { $type: "Book", id: "b3", title: "Dune", stock: 5 };
    // the second op reads what the first one changed
    expect(f).toEqual([
      { id: 1, ok: dune, patch: [{ set: "Book:b3", value: dune }], meta: { cost: 1 }, fin: true },
      { id: 2, data: { $type: "Book", title: "Dune", stock: 5 }, meta: { cost: 1 }, fin: true },
    ]);
  },
  policy: (f) => expect(f).toEqual([{ id: 1, error: { code: "permission_denied", message: "Not allowed to access Book.costPrice", path: "costPrice" }, fin: true }]),
  checked: (f) => expect(f).toEqual([{ id: 1, error: { code: "invalid_argument", message: "buy().qty: must be <= 10" }, fin: true }]),
};

describe("the playground's examples", () => {
  it.each(EXAMPLES.filter((e) => !e.request.ops.some((op) => op["live"])))("$title does what its summary says", async (example) => {
    const outcome = outcomes[example.id];
    expect(outcome, `no expected outcome for example ${example.id}`).toBeDefined();
    outcome!(await run(createEngine(BOOKSHOP_SCHEMA), example.request, example.viewer));
  });

  it("staff can read what the Staff only example refuses to a customer", async () => {
    const policy = EXAMPLES.find((e) => e.id === "policy")!;
    expect(await run(createEngine(BOOKSHOP_SCHEMA), policy.request, "staff")).toEqual([{ id: 1, data: { $type: "Book", title: "A Wizard of Earthsea", costPrice: "4.20" }, meta: { cost: 1 }, fin: true }]);
  });

  it("Live stock streams the first result, then the Restock button's change as a patch", async () => {
    const engine = createEngine(BOOKSHOP_SCHEMA);
    const live = EXAMPLES.find((e) => e.id === "live")!;
    const abort = new AbortController();
    const seen: Frame[] = [];
    const timer = setTimeout(() => abort.abort(), 5000);
    try {
      for await (const f of execute(engine, prepare(engine, live.request as RequestEnvelope), live.viewer, abort.signal)) {
        seen.push(f);
        if (seen.length === 1) await restock(engine, "b1");
        if (kindOf(f) === "patch") break;
      }
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
    expect(seen[0]).toMatchObject({ data: { title: "A Wizard of Earthsea", stock: 3 } });
    expect(seen.at(-1)).toEqual({ id: 1, patch: [{ at: "", value: { stock: 8 } }] });
    expect(kindOf(seen.at(-1)!)).toBe("patch");
  });

  it("each run gets fresh idempotency keys, and a key the request names is kept", () => {
    const engine = createEngine(BOOKSHOP_SCHEMA);
    const buy = EXAMPLES.find((e) => e.id === "buy")!.request as RequestEnvelope;
    const [a, b] = [prepare(engine, buy), prepare(engine, buy)];
    expect(a.ops[0]!.key).toMatch(/^pg-/);
    expect(a.ops[0]!.key).not.toBe(b.ops[0]!.key);
    expect(buy.ops[0]!.key).toBeUndefined();
    const named = prepare(engine, { ...buy, ops: [{ ...buy.ops[0]!, key: "mine-0123456789ab" }] });
    expect(named.ops[0]!.key).toBe("mine-0123456789ab");
    expect(prepare(engine, EXAMPLES[0]!.request as RequestEnvelope).ops[0]!.key).toBeUndefined();
  });

  it("the binary form of a page of books is smaller than its JSON", async () => {
    const engine = createEngine(BOOKSHOP_SCHEMA);
    const { json, rb } = sizes(engine, await run(engine, EXAMPLES.find((e) => e.id === "page")!.request, "anonymous"));
    expect(rb).toBeGreaterThan(0);
    expect(rb).toBeLessThan(json);
  });
});

describe("a schema of your own", () => {
  it("runs on generated data, and the bookshop schema does not", async () => {
    expect(createEngine(BOOKSHOP_SCHEMA).mocked).toBe(false);
    expect(createEngine(BOOKSHOP_SCHEMA.replace(/\n/g, "\r\n") + "\n\n").mocked).toBe(false);

    const engine = createEngine("entity Note { id: ID text: String }\nquery note(id: ID): Note?");
    expect(engine.mocked).toBe(true);
    const frames = await run(engine, { rayfold: "0.1", ops: [{ id: 1, op: "note", args: { id: "n1" }, shape: "{ id text }" }] }, "anonymous");
    // made up from the call, so the same on every run
    expect(frames).toEqual([{ id: 1, data: { $type: "Note", id: "note-277", text: "thistle cinder" }, meta: { cost: 1 }, fin: true }]);
  });

  it("a schema that does not read fails with the reader's own error", () => {
    expect(() => createEngine("entity Note { id: ID")).toThrow(RayfoldSyntaxError);
    expect(() => createEngine("entity Note { id: ID text: Missing }")).toThrow(RayfoldSchemaError);
  });
});
