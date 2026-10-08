/** The waiting helpers every suite leans on: a wait that is not bounded, or that resolves early, makes their tests lie. */
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Signal, WAIT_MS, bounded, openSse } from "./wait.ts";

/** Whether `p` has settled once pending microtasks and due timers have run, and how. */
async function state(p: Promise<unknown>): Promise<string> {
  let s = "pending";
  p.then(
    (v) => (s = `resolved ${JSON.stringify(v)}`),
    (e: unknown) => (s = `rejected ${(e as Error).message}`),
  );
  await vi.advanceTimersByTimeAsync(0);
  return s;
}

describe("bounded and Signal, on a clock the test moves", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("bounded fails with its label exactly at the bound, not before; guard: a promise that settles in time wins and leaves no timer", async () => {
    vi.useFakeTimers();
    const never = bounded(new Promise<never>(() => {}), "the reply", 200);
    never.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(199);
    expect(await state(never)).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(await state(never)).toBe("rejected no signal within 200 ms: the reply");

    const quick = bounded(Promise.resolve(7), "a quick one", 200);
    expect(await state(quick)).toBe("resolved 7");
    expect(vi.getTimerCount()).toBe(0); // the guard timer went with it
    // and the default bound is the suite-wide one
    const defaulted = bounded(new Promise<never>(() => {}), "defaulted");
    defaulted.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(WAIT_MS - 1);
    expect(await state(defaulted)).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(await state(defaulted)).toBe(`rejected no signal within ${WAIT_MS} ms: defaulted`);
  });

  it("until resolves at once when the condition already holds, and on the push that makes it hold", async () => {
    vi.useFakeTimers();
    const s = new Signal<number>();
    s.push(1);
    expect(await state(s.until((xs) => xs.includes(1), "already there", 100))).toBe("resolved [1]");
    expect(vi.getTimerCount()).toBe(0); // nothing to wait for, so nothing armed

    const two = s.until((xs) => xs.includes(2), "a two", 100);
    s.push(3);
    expect(await state(two)).toBe("pending"); // guard: a push that does not satisfy it does not resolve it
    s.push(2);
    expect(await state(two)).toBe("resolved [1,3,2]");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("until fails at its own bound with its label; atLeast counts exactly and is bounded by the suite-wide wait", async () => {
    vi.useFakeTimers();
    const s = new Signal<string>();
    const missed = s.until(() => false, "a condition that never holds", 100);
    missed.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(100);
    expect(await state(missed)).toBe("rejected no signal within 100 ms: a condition that never holds");

    const two = s.atLeast(2, "two items");
    two.catch(() => undefined);
    s.push("a");
    expect(await state(two)).toBe("pending");
    s.push("b");
    expect(await state(two)).toBe('resolved ["a","b"]');

    const four = s.atLeast(4, "four items");
    four.catch(() => undefined);
    s.push("c");
    await vi.advanceTimersByTimeAsync(WAIT_MS - 1);
    expect(await state(four)).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(await state(four)).toBe(`rejected no signal within ${WAIT_MS} ms: four items`);
  });
});

describe("openSse over a real socket", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) {
      const s = server;
      await new Promise<void>((r) => {
        s.close(() => r());
        s.closeAllConnections();
      });
    }
    server = undefined;
  });

  it("is ready once the server's first bytes arrive, parses data lines split across writes, skips comments, and close() drops the response", async () => {
    const responses = new Signal<ServerResponse>();
    const closed = new Signal<"closed">();
    server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": connected\n\n");
      req.on("close", () => closed.push("closed"));
      responses.push(res);
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const sse = openSse(`http://127.0.0.1:${(server.address() as AddressInfo).port}/events`);
    await sse.ready;
    const [res] = await responses.atLeast(1, "the stream's response");
    expect(sse.events.items).toEqual([]); // the comment is not an event

    res!.write('data: {"n":1}\n\ndata: {"n"');
    await sse.events.atLeast(1, "the first event");
    res!.write(':2}\n\n: a comment\n\ndata: {"n":3}\n\n');
    await sse.events.atLeast(3, "the event split across writes and the one after it");
    expect(sse.events.items).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);

    await bounded(sse.close(), "close() returning");
    await closed.atLeast(1, "the server seeing the client go");
  });
});
