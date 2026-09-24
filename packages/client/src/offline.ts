/**
 * The offline queue of sub-profile `sync` (spec 08 section 5): commands made while the server cannot be reached wait,
 * in the order they were made and with their idempotency keys, and go out when the connection is back. The keys make
 * the resend safe: a command the server ran before its answer was lost is replayed, not run again.
 */
import type { OptimisticOp } from "./cache.ts";
import type { OpOptions } from "./client.ts";

/** A command waiting for the server: everything needed to send it again, and to show its prediction meanwhile. */
export interface QueuedCommand {
  key: string;
  op: string;
  args: Record<string, unknown>;
  options: OpOptions;
  optimistic?: OptimisticOp[];
  queuedAt: number;
  /** Order of creation: a command queued late because its attempt failed late still goes out in its place. */
  seq: number;
}

/** Where the queue is kept, so waiting commands survive a reload. */
export interface QueueStorage {
  load(): QueuedCommand[] | Promise<QueuedCommand[]>;
  save(queue: readonly QueuedCommand[]): void | Promise<void>;
}

export interface QueueEvent {
  type: "queued" | "sent" | "failed";
  command: QueuedCommand;
  /** Why the server refused a queued command (`failed`). */
  error?: unknown;
  /** Commands still waiting after this event. */
  pending: number;
}

/** Keeps the queue in memory only: waiting commands are lost with the page. */
export function memoryQueue(): QueueStorage {
  let saved: QueuedCommand[] = [];
  return { load: () => structuredClone(saved), save: (q) => void (saved = structuredClone([...q])) };
}

/** Keeps the queue in `localStorage` (or any storage with the same three methods) under `name`. */
export function localStorageQueue(name = "rayfold.queue", storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined = globalThis.localStorage): QueueStorage {
  return {
    load: () => {
      const raw = storage?.getItem(name);
      if (!raw) return [];
      try {
        const v: unknown = JSON.parse(raw);
        return Array.isArray(v) ? (v as QueuedCommand[]) : [];
      } catch {
        return []; // a damaged entry is dropped rather than blocking every later command
      }
    },
    save: (q) => {
      if (!storage) return;
      if (q.length) storage.setItem(name, JSON.stringify(q));
      else storage.removeItem(name);
    },
  };
}

/** Whether a failure means the server could not be reached, so the command may go out again later with its key. */
export function isUnreachable(e: unknown): boolean {
  if (e instanceof TypeError) return true; // what fetch throws when the network fails
  return (e as { code?: unknown } | null)?.code === "unavailable";
}

interface Entry {
  command: QueuedCommand;
  resolve?: (v: unknown) => void;
  reject?: (e: unknown) => void;
}

/** @internal The queue itself; RayfoldClient owns one when created with `offline`. */
export class OfflineQueue {
  private readonly entries: Entry[] = [];
  private draining: Promise<number> | null = null;
  private again: Promise<number> | null = null;
  private readonly listeners = new Set<(e: QueueEvent) => void>();
  readonly restored: Promise<void>;

  constructor(
    private readonly storage: QueueStorage,
    private readonly send: (c: QueuedCommand) => Promise<unknown>,
    /** Called once a command has left the queue, sent or refused: its prediction goes. */
    private readonly settle: (c: QueuedCommand) => void,
    /** Called for each command a reload brought back: its prediction is shown again. */
    restore: (c: QueuedCommand) => void,
  ) {
    this.restored = Promise.resolve(storage.load()).then((saved) => {
      for (const command of saved) {
        this.entries.push({ command });
        restore(command);
      }
    });
  }

  get size(): number {
    return this.entries.length;
  }

  get commands(): readonly QueuedCommand[] {
    return this.entries.map((e) => e.command);
  }

  add<T>(command: QueuedCommand): Promise<T> {
    const p = new Promise<T>((resolve, reject) => {
      const at = this.entries.findIndex((e) => e.command.seq > command.seq);
      this.entries.splice(at < 0 ? this.entries.length : at, 0, { command, resolve: resolve as (v: unknown) => void, reject });
    });
    p.catch(() => {}); // a caller that fired and forgot must not see an unhandled rejection later
    void this.storage.save(this.commands);
    this.emit({ type: "queued", command, pending: this.entries.length });
    return p;
  }

  /** Sends waiting commands in order and resolves to how many still wait: the rest stay when the server is unreachable. */
  drain(): Promise<number> {
    // A run already going may have found the server away before this call: a drain asked for now tries again after it,
    // so what it answers is about now. Callers that arrive meanwhile share that one follow-up run.
    if (this.draining) return (this.again ??= this.draining.then(() => {
      this.again = null;
      return this.drain();
    }));
    this.draining = this.run().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  private async run(): Promise<number> {
    await this.restored;
    while (this.entries.length) {
      const e = this.entries[0]!;
      let result: unknown;
      try {
        result = await this.send(e.command);
      } catch (err) {
        if (isUnreachable(err)) break; // still offline: it and everything behind it keep waiting
        this.entries.shift();
        await this.storage.save(this.commands);
        this.settle(e.command);
        e.reject?.(err);
        this.emit({ type: "failed", command: e.command, error: err, pending: this.entries.length });
        continue;
      }
      this.entries.shift();
      await this.storage.save(this.commands);
      this.settle(e.command);
      e.resolve?.(result);
      this.emit({ type: "sent", command: e.command, pending: this.entries.length });
    }
    return this.entries.length;
  }

  subscribe(fn: (e: QueueEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: QueueEvent): void {
    for (const fn of this.listeners) fn(e);
  }
}
