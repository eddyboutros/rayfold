/**
 * What one server learned, carried to every other server it shares a relay with: the entities a command changed, so
 * their live queries re-run, and the events it emitted, so their streams deliver. Without a relay each server hears
 * only itself, which is right for one server and silently wrong for two behind a load balancer.
 *
 * A relay never hands a server back what that server published: its own buses heard that already. `MemoryRelay`
 * joins servers in one process, for tests and for several instances in one process; `PgRelay` in `@rayfold/postgres`
 * joins processes through the database they already share.
 */
export type RelayMessage =
  | { kind: "change"; keys: string[]; ops: string[] }
  | { kind: "event"; name: string; payload: Record<string, unknown> };

export interface Relay {
  /** Carries the message to every other server on the relay. Resolves once it is handed over, not once delivered. */
  publish(message: RelayMessage): Promise<void>;
  /** Starts delivering the other servers' messages; resolves once this server is listening. The function returned stops it. */
  subscribe(onMessage: (message: RelayMessage) => void): Promise<() => Promise<void>>;
}

/** Joins servers that run in one process: `join()` gives each server its own end of the relay. */
export class MemoryRelay {
  private readonly ends = new Set<(message: RelayMessage) => void>();

  join(): Relay {
    const ends = this.ends;
    let mine: ((message: RelayMessage) => void) | undefined;
    return {
      async publish(message) {
        // a copy per receiver, as a wire would give: no server sees another's later edits to the payload
        for (const deliver of ends) if (deliver !== mine) deliver(structuredClone(message));
      },
      async subscribe(onMessage) {
        if (mine) ends.delete(mine);
        mine = onMessage;
        ends.add(onMessage);
        return async () => {
          ends.delete(onMessage);
          if (mine === onMessage) mine = undefined;
        };
      },
    };
  }

  /** Servers listening right now. */
  get size(): number {
    return this.ends.size;
  }
}
