import { beforeEach, describe, expect, it } from "vitest";
import { Signal } from "../../../e2e/wait.ts";
import { createBookstore } from "../../../examples/bookstore-ts/src/index.ts";
import { RayfoldClient } from "./client.ts";
import { createLocalTransport, type Transport } from "./transport.ts";

// A watch calls back when its own result changes. With many watches of one op (a list of book cards), a change to
// one book must not call back every card: that is one re-render per card in @rayfold/react.

let bs: ReturnType<typeof createBookstore>;
let client: RayfoldClient;

beforeEach(() => {
  bs = createBookstore();
  client = new RayfoldClient({ transport: createLocalTransport(bs.server, () => ({ id: "u1", role: "customer" })) });
});

const SHAPE = { shape: "{ id stock }" };
const order = (bookId: string) => client.command("placeOrder", { input: { lines: [{ bookId, qty: 1 }] } });

describe("watch() calls back for its own result only", () => {
  it("a command changing one book calls back that book's watch, not the watch of another book", async () => {
    const b1 = new Signal<number>();
    const b2 = new Signal<number>();
    const stops = [client.watch<{ stock: number }>("book", { id: "b1" }, SHAPE, (b) => b1.push(b.stock)), client.watch<{ stock: number }>("book", { id: "b2" }, SHAPE, (b) => b2.push(b.stock))];
    await b1.atLeast(1, "b1 loaded");
    await b2.atLeast(1, "b2 loaded");
    await order("b1");
    await b1.atLeast(2, "b1 patched");
    await order("b2");
    await b2.atLeast(2, "b2 patched");
    // each watch saw its initial value and its own book's change, nothing more
    expect(b1.items).toEqual([5, 4]);
    expect(b2.items).toEqual([2, 1]);
    for (const stop of stops) stop();
  });

  it("a refetch of the watched query calls back even when the data is unchanged", async () => {
    const seen = new Signal<number>();
    const stop = client.watch<{ stock: number }>("book", { id: "b1" }, SHAPE, (b) => seen.push(b.stock));
    await seen.atLeast(1, "loaded");
    await client.query("book", { id: "b1" }, SHAPE);
    await seen.atLeast(2, "refetched");
    expect(seen.items).toEqual([5, 5]);
    stop();
    // guard: a stopped watch is told nothing more
    await client.query("book", { id: "b1" }, SHAPE);
    await order("b1");
    expect(seen.items).toEqual([5, 5]);
  });

  it("guard: a query for another book, same op, does not call back", async () => {
    const seen = new Signal<number>();
    const other = new Signal<number>();
    const stops = [client.watch<{ stock: number }>("book", { id: "b1" }, SHAPE, (b) => seen.push(b.stock)), client.watch<{ stock: number }>("book", { id: "b2" }, SHAPE, (b) => other.push(b.stock))];
    await seen.atLeast(1, "b1 loaded");
    await other.atLeast(1, "b2 loaded");
    await client.query("book", { id: "b2" }, SHAPE);
    await other.atLeast(2, "b2 refetched");
    expect(seen.items).toEqual([5]);
    expect(other.items).toEqual([2, 2]);
    for (const stop of stops) stop();
  });

  it("an invalidated op calls back every watch of that op", async () => {
    const b1 = new Signal<unknown>();
    const b2 = new Signal<unknown>();
    const others = new Signal<unknown>();
    const stops = [
      client.watch("book", { id: "b1" }, SHAPE, (b) => b1.push(b)),
      client.watch("book", { id: "b2" }, SHAPE, (b) => b2.push(b)),
      client.watch("author", { id: "a1" }, { shape: "{ id name }" }, (a) => others.push(a)),
    ];
    await b1.atLeast(1, "b1 loaded");
    await b2.atLeast(1, "b2 loaded");
    await others.atLeast(1, "the author loaded");
    client.cache.applyPatch([{ invOp: ["book"] }]);
    await b1.atLeast(2, "b1 told");
    await b2.atLeast(2, "b2 told");
    expect(b1.items).toEqual([{ $type: "Book", id: "b1", stock: 5 }, { $type: "Book", id: "b1", stock: 5 }]);
    expect(b2.items).toEqual([{ $type: "Book", id: "b2", stock: 2 }, { $type: "Book", id: "b2", stock: 2 }]);
    // guard: a watch of another op is not told of this op's invalidation
    expect(others.items).toHaveLength(1);
    for (const stop of stops) stop();
  });

  it("a change landing after the data frame but before the response ended is reported, not hidden by the response", async () => {
    const local = createLocalTransport(bs.server, () => ({ id: "u1", role: "customer" }));
    const held = new Signal<string>();
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const transport: Transport = {
      send: (env, o) =>
        (async function* () {
          yield* local.send(env, o);
          // the query's frames are all in, and its response has not ended yet
          if (env.ops[0]!.op === "book") {
            held.push("held");
            await hold;
          }
        })(),
    };
    const c = new RayfoldClient({ transport });
    const seen = new Signal<number>();
    const stop = c.watch<{ stock: number }>("book", { id: "b1" }, SHAPE, (b) => seen.push(b.stock));
    await held.atLeast(1, "the watch's response held open");
    await c.command("placeOrder", { input: { lines: [{ bookId: "b1", qty: 1 }] } });
    release();
    await seen.atLeast(1, "the watch's first report");
    expect(seen.items).toEqual([4]);
    stop();
  });

  it("a command landing while the watch is still loading is not lost", async () => {
    const seen = new Signal<number>();
    // no await between the two: the command lands while the watch's own first fetch is still in flight, which on
    // the server side was a real hole (spec 08 section 3). The watch reports the stock its fetch read and then the
    // command's change, once each: neither dropped nor doubled.
    const stop = client.watch<{ stock: number }>("book", { id: "b1" }, SHAPE, (b) => seen.push(b.stock));
    await order("b1");
    await seen.until((xs) => xs.at(-1) === 4, "watch delivered the ordered stock");
    expect(seen.items).toEqual([5, 4]);
    stop();
  });
});
