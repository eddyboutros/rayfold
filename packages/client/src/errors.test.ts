import { beforeEach, describe, expect, it } from "vitest";
import { Signal } from "../../../e2e/wait.ts";
import { createBookstore } from "../../../examples/bookstore-ts/src/index.ts";
import { RayfoldClient, RayfoldClientError } from "./client.ts";
import { createLocalTransport, type Transport } from "./transport.ts";

// watch() and live() are how UI bindings (@rayfold/react) learn about failures; before onError they dropped them.

let bs: ReturnType<typeof createBookstore>;
let client: RayfoldClient;

beforeEach(() => {
  bs = createBookstore();
  client = new RayfoldClient({ transport: createLocalTransport(bs.server, () => ({ id: "u1", role: "customer" })) });
});

/** A transport whose every request waits for `release`, then fails as a lost connection would. */
function gatedOffline(): { transport: Transport; release: () => void } {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  return {
    release,
    transport: {
      send: async function* () {
        await gate;
        throw new Error("offline");
      },
    },
  };
}

/** One event-loop turn: every promise reaction queued so far has run. Not a timer on the clock. */
const settle = () => new Promise<void>((r) => setImmediate(r));

describe("watch() reports failures to onError", () => {
  it("a rejected initial fetch reaches onError as a RayfoldClientError, and fn is never called", async () => {
    const data = new Signal<unknown>();
    const errors = new Signal<unknown>();
    client.watch("book", {}, {}, (d) => data.push(d), (e) => errors.push(e));
    const [e] = await errors.atLeast(1, "watch onError");
    expect(e).toBeInstanceOf(RayfoldClientError);
    expect((e as RayfoldClientError).code).toBe("invalid_argument");
    expect(data.items).toEqual([]);
  });

  it("guard: a watch that loads and then follows a command's patch never calls onError", async () => {
    const stock = new Signal<number>();
    const errors: unknown[] = [];
    const stop = client.watch<{ stock: number }>("book", { id: "b1" }, { shape: "{ id stock }" }, (b) => stock.push(b.stock), (e) => errors.push(e));
    await stock.atLeast(1, "initial data");
    await client.command("placeOrder", { input: { lines: [{ bookId: "b1", qty: 1 }] } });
    await stock.atLeast(2, "patched data");
    expect(stock.items[1]).toBe(stock.items[0]! - 1);
    expect(errors).toEqual([]);
    stop();
  });

  it("a failure that arrives after stop() is not reported", async () => {
    const { transport, release } = gatedOffline();
    const offline = new RayfoldClient({ transport });
    const stopped: unknown[] = [];
    const active = new Signal<unknown>();
    const stop = offline.watch("book", { id: "b1" }, {}, () => {}, (e) => stopped.push(e));
    offline.watch("book", { id: "b2" }, {}, () => {}, (e) => active.push(e));
    stop();
    release();
    // both requests fail on the same gate; reactions run in order, so the stopped watch has been handled by now
    const [e] = await active.atLeast(1, "the active watch's failure");
    expect((e as Error).message).toBe("offline");
    expect(stopped).toEqual([]);
  });
});

describe("live() reports failures to onError", () => {
  it("an error frame for the op reaches onError, and fn is never called", async () => {
    const data: unknown[] = [];
    const errors = new Signal<unknown>();
    const stop = client.live("book", {}, {}, (d) => data.push(d), (e) => errors.push(e));
    const [e] = await errors.atLeast(1, "live onError");
    expect(e).toBeInstanceOf(RayfoldClientError);
    expect((e as RayfoldClientError).code).toBe("invalid_argument");
    expect(data).toEqual([]);
    stop();
  });

  it("a lost connection reaches onError", async () => {
    const { transport, release } = gatedOffline();
    const errors = new Signal<unknown>();
    new RayfoldClient({ transport }).live("book", { id: "b1" }, {}, () => {}, (e) => errors.push(e));
    release();
    const [e] = await errors.atLeast(1, "connection failure");
    expect((e as Error).message).toBe("offline");
  });

  it("guard: unsubscribing aborts the stream without reporting the abort as an error", async () => {
    const stock = new Signal<number>();
    const errors: unknown[] = [];
    const stop = client.live<{ stock: number }>("book", { id: "b1" }, { shape: "{ id stock }" }, (b) => stock.push(b.stock), (e) => errors.push(e));
    await stock.atLeast(1, "initial live data");
    await client.command("placeOrder", { input: { lines: [{ bookId: "b1", qty: 1 }] } });
    await stock.atLeast(2, "pushed change");
    stop();
    await settle();
    await client.command("placeOrder", { input: { lines: [{ bookId: "b1", qty: 1 }] } });
    await settle();
    expect(stock.items).toHaveLength(2);
    expect(errors).toEqual([]);
  });
});
