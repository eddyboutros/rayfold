/**
 * Event-driven waiting for end-to-end tests. Nothing here sleeps: tests await the signal they need, and every
 * wait is bounded so a missed signal fails the test with a label instead of hanging the run.
 */
export const WAIT_MS = 5000;

/** Races `p` against a guard timer that only ever fails; the timer never synchronizes anything. */
export function bounded<T>(p: Promise<T>, label: string, ms = WAIT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`no signal within ${ms} ms: ${label}`)), ms);
  });
  return Promise.race([p, guard]).finally(() => clearTimeout(timer));
}

/** An append-only list that tests can await conditions on. */
export class Signal<T> {
  readonly items: T[] = [];
  private waiters: Array<{ cond: (items: T[]) => boolean; resolve: () => void }> = [];

  push(v: T): void {
    this.items.push(v);
    this.waiters = this.waiters.filter((w) => {
      if (!w.cond(this.items)) return true;
      w.resolve();
      return false;
    });
  }

  /** Resolves once `cond` holds for the items seen so far (checked now and after every push). */
  until(cond: (items: T[]) => boolean, label: string): Promise<T[]> {
    if (cond(this.items)) return Promise.resolve(this.items);
    return bounded(new Promise<T[]>((resolve) => this.waiters.push({ cond, resolve: () => resolve(this.items) })), label);
  }

  atLeast(n: number, label: string): Promise<T[]> {
    return this.until((items) => items.length >= n, label);
  }
}

/**
 * Opens a Server-Sent Events stream. `ready` resolves when the server has sent its first bytes (the servers in
 * this harness send a comment line as soon as the subscription is registered), so a test can trigger the event
 * it expects without racing the subscription.
 */
export function openSse(url: string, init: RequestInit = {}): { events: Signal<unknown>; ready: Promise<void>; close: () => Promise<void> } {
  const events = new Signal<unknown>();
  const ac = new AbortController();
  let markReady: () => void = () => {};
  const ready = bounded(new Promise<void>((r) => (markReady = r)), `SSE ${url} connected`);
  const done = fetch(url, { ...init, signal: ac.signal })
    .then(async (res) => {
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          markReady();
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            for (const line of chunk.split("\n")) if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)));
          }
        }
      } catch {
        /* aborted by close() */
      }
    })
    .catch(() => undefined);
  return {
    events,
    ready,
    close: async () => {
      ac.abort();
      await done;
    },
  };
}
