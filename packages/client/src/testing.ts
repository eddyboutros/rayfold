/**
 * Test support for applications built on @rayfold/client: waiting for what a watch, a live query or a stream reports
 * next. Nothing here sleeps, and every wait is bounded, so a value that never comes fails the test with a message
 * instead of hanging the run.
 *
 *   const stock = collect<Book>((next, fail) => client.live("book", { id: "b1" }, { shape: "{ id stock }" }, next, fail));
 *   expect(await stock.next("the stock when the query opened")).toMatchObject({ stock: 3 });
 *   stock.stop();
 */

/**
 * Starts what is being followed. `next` and `fail` go where `client.watch` and `client.live` take their callbacks, and
 * what they return, the function that ends the subscription, is returned from here. A stream has no callbacks: return
 * `client.stream(op, args, { signal })` itself, with the `signal` given here, which `stop()` aborts.
 */
export type Subscribe<T> = (next: (value: T) => void, fail: (error: unknown) => void, signal: AbortSignal) => (() => void) | AsyncIterable<T>;

export interface Collected<T> {
  /** Every value reported so far, oldest first. */
  readonly values: readonly T[];
  /**
   * What was reported next, in order: each call hands out one value, waiting for it when it has not arrived yet. A
   * failure reported through `fail`, or thrown by a stream, rejects the call that reaches it. Rejects after `ms` with
   * nothing reported, and at once when there is nothing left to wait for: the stream ended, or `stop()` was called.
   *
   * `ms` is 4000 unless given: under the 5 seconds test runners allow a test by default, so that a value that never
   * comes fails with this call's message, which names what was awaited, and not with the runner's timeout.
   */
  next(label?: string, ms?: number): Promise<T>;
  /** Ends the subscription. Nothing reported after this is kept. */
  stop(): void;
}

type Item<T> = { value: T } | { error: unknown };

export function collect<T>(subscribe: Subscribe<T>): Collected<T> {
  const values: T[] = [];
  /** Reported and not yet handed out. */
  const arrived: Array<Item<T>> = [];
  const waiting: Array<{ take: (item: Item<T>) => void; close: (why: string) => void }> = [];
  /** Why nothing more will come, once that is so. */
  let closed: string | undefined;
  const abort = new AbortController();

  const report = (item: Item<T>): void => {
    if (closed !== undefined) return;
    if ("value" in item) values.push(item.value);
    const waiter = waiting.shift();
    if (waiter) waiter.take(item);
    else arrived.push(item);
  };
  const close = (why: string): void => {
    if (closed !== undefined) return;
    closed = why;
    for (const waiter of waiting.splice(0)) waiter.close(why);
  };
  const seen = (): string => `saw ${values.length ? JSON.stringify(values) : "nothing"}`;

  const source = subscribe((value) => report({ value }), (error) => report({ error }), abort.signal);
  if (typeof source !== "function") {
    void (async () => {
      try {
        for await (const value of source) report({ value });
        close("the stream ended");
      } catch (error) {
        report({ error });
        close("the stream failed");
      }
    })();
  }

  return {
    values,
    next(label = "the next value", ms = 4000) {
      return new Promise<T>((resolve, reject) => {
        const settle = (item: Item<T>) => ("value" in item ? resolve(item.value) : reject(item.error));
        const ready = arrived.shift();
        if (ready) return settle(ready);
        if (closed !== undefined) return reject(new Error(`${closed} before ${label}: ${seen()}`));
        const waiter = {
          take: (item: Item<T>) => (clearTimeout(timer), settle(item)),
          close: (why: string) => (clearTimeout(timer), reject(new Error(`${why} before ${label}: ${seen()}`))),
        };
        // a guard that only ever fails the test: it decides nothing about when a value counts as arrived
        const timer = setTimeout(() => {
          waiting.splice(waiting.indexOf(waiter), 1);
          reject(new Error(`no value within ${ms} ms: ${label}: ${seen()}`));
        }, ms);
        waiting.push(waiter);
      });
    },
    stop() {
      close("stopped");
      if (typeof source === "function") source();
      abort.abort();
    },
  };
}
