import { afterEach, describe, expect, it, vi } from "vitest";
import type { ErrorCode, Frame } from "@rayfold/server";
import { RayfoldClient } from "./client.ts";
import type { Transport } from "./transport.ts";

/**
 * A live query outlives the server it was opened on: a rolling deploy ends it with a retryable error, and the client
 * opens it again through the balancer without the application doing anything.
 */
const book = (stock: number): Frame => ({ id: 1, data: { $type: "Book", id: "b1", stock }, meta: { cost: 1 } });
const ended = (code: ErrorCode, message: string): Frame => ({ id: 1, error: { code, message }, fin: true });
const goingAway = ended("unavailable", "The server is shutting down");

/**
 * A transport that answers each open of the live query with the next script: its frames, then held open until the
 * client goes away, as a server does; or a failure to connect at all.
 */
function scripted(runs: Array<Frame[] | Error | { dropped: Frame[] }>): { transport: Transport; opened: () => number } {
  let opened = 0;
  const transport: Transport = {
    send(_env, opts) {
      const script = runs[opened++] ?? [];
      return (async function* () {
        if (script instanceof Error) throw script;
        if (!Array.isArray(script)) {
          yield* script.dropped; // then the response just ends, as a connection closed underneath it does
          return;
        }
        for (const f of script) yield f;
        if (script.some((f) => "fin" in f && f.fin)) return;
        await new Promise<void>((resolve) => opts?.signal?.addEventListener("abort", () => resolve(), { once: true }));
        yield ended("canceled", "Canceled");
      })();
    },
  };
  return { transport, opened: () => opened };
}

afterEach(() => vi.useRealTimers());

describe("a live query reconnects", () => {
  it("opens the query again after a server goes away, half a second later, and delivers what the new server sends", async () => {
    vi.useFakeTimers();
    const t = scripted([[book(3), goingAway], [book(4)]]);
    const client = new RayfoldClient({ transport: t.transport });
    const seen: number[] = [];
    const errors: Array<{ code: string; retrying: boolean }> = [];
    const stop = client.live<{ stock: number }>("book", { id: "b1" }, { shape: "{ id stock }" }, (d) => seen.push(d.stock), (e, m) => errors.push({ code: (e as { code: string }).code, retrying: m.retrying }));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([3]);
    expect(errors).toEqual([{ code: "unavailable", retrying: true }]);
    expect(t.opened()).toBe(1);

    await vi.advanceTimersByTimeAsync(499);
    expect(t.opened()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.opened()).toBe(2);
    expect(seen).toEqual([3, 4]);
    stop();
  });

  it("guard: an error that would recur ends the query instead", async () => {
    vi.useFakeTimers();
    const t = scripted([[ended("permission_denied", "Not yours")], [book(1)]]);
    const client = new RayfoldClient({ transport: t.transport });
    const seen: number[] = [];
    const errors: Array<{ code: string; retrying: boolean }> = [];
    client.live<{ stock: number }>("book", { id: "b1" }, {}, (d) => seen.push(d.stock), (e, m) => errors.push({ code: (e as { code: string }).code, retrying: m.retrying }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(errors).toEqual([{ code: "permission_denied", retrying: false }]);
    expect(t.opened()).toBe(1);
    expect(seen).toEqual([]);
  });

  it("waits longer each time it fails again, and starts over once data arrives", async () => {
    vi.useFakeTimers();
    const t = scripted([[goingAway], [goingAway], [book(5), goingAway], [book(6)]]);
    const client = new RayfoldClient({ transport: t.transport });
    const seen: number[] = [];
    const stop = client.live<{ stock: number }>("book", { id: "b1" }, {}, (d) => seen.push(d.stock));
    await vi.advanceTimersByTimeAsync(500);
    expect(t.opened()).toBe(2); // the second open, after 500 ms
    await vi.advanceTimersByTimeAsync(999);
    expect(t.opened()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.opened()).toBe(3); // the third, after 1000 ms
    expect(seen).toEqual([5]);
    await vi.advanceTimersByTimeAsync(500); // data arrived on the third open, so the wait is short again
    expect(t.opened()).toBe(4);
    expect(seen).toEqual([5, 6]);
    stop();
  });

  it("stops doubling the wait at thirty seconds", async () => {
    vi.useFakeTimers();
    const t = scripted([...Array.from({ length: 8 }, () => [goingAway]), [book(7)]]);
    const client = new RayfoldClient({ transport: t.transport });
    const seen: number[] = [];
    const stop = client.live<{ stock: number }>("book", { id: "b1" }, {}, (d) => seen.push(d.stock));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500 + 1_000 + 2_000 + 4_000 + 8_000 + 16_000);
    expect(t.opened()).toBe(7);
    // doubling again would wait 32 s
    await vi.advanceTimersByTimeAsync(29_999);
    expect(t.opened()).toBe(7);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.opened()).toBe(8);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(t.opened()).toBe(8);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.opened()).toBe(9);
    expect(seen).toEqual([7]);
    stop();
  });

  it("a failure to connect at all is retried too, as a deploy in progress looks from outside", async () => {
    vi.useFakeTimers();
    const t = scripted([new TypeError("fetch failed"), [book(2)]]);
    const client = new RayfoldClient({ transport: t.transport });
    const seen: number[] = [];
    const errors: Array<{ message: string; retrying: boolean }> = [];
    const stop = client.live<{ stock: number }>("book", { id: "b1" }, {}, (d) => seen.push(d.stock), (e, m) => errors.push({ message: (e as Error).message, retrying: m.retrying }));
    await vi.advanceTimersByTimeAsync(500);
    expect(errors).toEqual([{ message: "fetch failed", retrying: true }]);
    expect(seen).toEqual([2]);
    stop();
  });

  it("unsubscribing while waiting to reconnect cancels the reconnect", async () => {
    vi.useFakeTimers();
    const t = scripted([[book(3), goingAway], [book(4)]]);
    const client = new RayfoldClient({ transport: t.transport });
    const seen: number[] = [];
    const stop = client.live<{ stock: number }>("book", { id: "b1" }, {}, (d) => seen.push(d.stock));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([3]);
    stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.opened()).toBe(1);
    expect(seen).toEqual([3]);
  });

  // an error for the whole batch carries no op id: a draining server's 503, or a refused envelope
  const refused = (code: ErrorCode, message: string): Frame => ({ error: { code, message }, fin: true }) as Frame;

  it("a refusal of the whole batch is this query's too: a draining server's unavailable is reported and retried", async () => {
    vi.useFakeTimers();
    const t = scripted([[book(3), goingAway], [refused("unavailable", "The server is shutting down")], [book(4)]]);
    const client = new RayfoldClient({ transport: t.transport });
    const seen: number[] = [];
    const errors: Array<{ code: string; retrying: boolean }> = [];
    const stop = client.live<{ stock: number }>("book", { id: "b1" }, {}, (d) => seen.push(d.stock), (e, m) => errors.push({ code: (e as { code: string }).code, retrying: m.retrying }));
    await vi.advanceTimersByTimeAsync(500); // the reopen reaches a server that is draining too
    expect(t.opened()).toBe(2);
    expect(errors).toEqual([{ code: "unavailable", retrying: true }, { code: "unavailable", retrying: true }]);
    await vi.advanceTimersByTimeAsync(1000); // twice the wait, then a server that answers
    expect(t.opened()).toBe(3);
    expect(seen).toEqual([3, 4]);
    stop();
  });

  it("guard: a refusal that would recur is reported and ends the query", async () => {
    vi.useFakeTimers();
    const t = scripted([[refused("invalid_argument", "unknown operation \"book\"")], [book(1)]]);
    const client = new RayfoldClient({ transport: t.transport });
    const errors: Array<{ code: string; retrying: boolean }> = [];
    client.live("book", { id: "b1" }, {}, () => {}, (e, m) => errors.push({ code: (e as { code: string }).code, retrying: m.retrying }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(errors).toEqual([{ code: "invalid_argument", retrying: false }]);
    expect(t.opened()).toBe(1);
  });

  it("a response that ends without an error is a dropped connection: reported as unavailable and opened again", async () => {
    vi.useFakeTimers();
    const t = scripted([{ dropped: [book(3)] }, [book(4)]]);
    const client = new RayfoldClient({ transport: t.transport });
    const seen: number[] = [];
    const errors: Array<{ code: string; retrying: boolean }> = [];
    const stop = client.live<{ stock: number }>("book", { id: "b1" }, {}, (d) => seen.push(d.stock), (e, m) => errors.push({ code: (e as { code: string }).code, retrying: m.retrying }));
    await vi.advanceTimersByTimeAsync(500);
    expect(errors).toEqual([{ code: "unavailable", retrying: true }]);
    expect(t.opened()).toBe(2);
    expect(seen).toEqual([3, 4]);
    stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.opened()).toBe(2); // guard: stopping it is not a drop, and nothing reopens
  });
});
