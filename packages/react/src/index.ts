/**
 * React bindings for @rayfold/client, built on useSyncExternalStore. Components re-render when the client cache
 * changes, so a command's patch updates every component that shows the same entity, with no refetch.
 *
 *   <RayfoldProvider client={client}><App /></RayfoldProvider>
 *   const { data, error, loading } = useQuery<Book>("book", { id });
 *   const [restock, { running }] = useCommand<Book>("restock");
 */
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { RayfoldCache, type OpOptions, type QueryOptions, type RayfoldClient , type CommandOptions } from "@rayfold/client";

const ClientContext = createContext<RayfoldClient | null>(null);

/** Makes `client` available to the hooks below it. */
export function RayfoldProvider(props: { client: RayfoldClient; children?: ReactNode }): ReactNode {
  return createElement(ClientContext.Provider, { value: props.client }, props.children);
}

/** The client from the nearest RayfoldProvider. */
export function useRayfoldClient(): RayfoldClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error("Rayfold hooks need a <RayfoldProvider client={...}> above them in the tree");
  return client;
}

export interface QueryState<T> {
  /** The latest result. On mount it is the cached result when this query ran before, while the fresh one loads. */
  data: T | undefined;
  /** The last failure (a RayfoldClientError for errors the server reported); cleared by the next result. */
  error: unknown;
  /** True until the first result or error for these arguments arrives. */
  loading: boolean;
}

export interface QueryResult<T> extends QueryState<T> {
  /** Fetches again from the server. */
  refetch(): Promise<void>;
}

export interface UseQueryOptions extends QueryOptions {
  /** false: send nothing (for example until an id is known). Default true. */
  enabled?: boolean;
}

export interface UseLiveOptions extends OpOptions {
  /** false: do not subscribe. Default true. */
  enabled?: boolean;
}

export interface CommandState<T> {
  /** The last successful result. */
  data: T | undefined;
  /** The last failure; `error.is("OutOfStock")` narrows on a declared error type. */
  error: unknown;
  running: boolean;
}

type Start<T> = (set: (next: Partial<QueryState<T>>) => void) => () => void;

/** The state behind one hook call: subscribes on the first listener, unsubscribes when the last one leaves. */
class Store<T> {
  private state: QueryState<T>;
  private readonly listeners = new Set<() => void>();
  private stop: (() => void) | undefined;

  constructor(
    private readonly initial: QueryState<T>,
    private readonly start: Start<T>,
  ) {
    this.state = initial;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.stop = this.start(this.set);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.stop?.();
        this.stop = undefined;
      }
    };
  };

  readonly getSnapshot = (): QueryState<T> => this.state;

  /** Server rendering: the state before any request, since nothing is fetched on the server. */
  readonly getServerSnapshot = (): QueryState<T> => this.initial;

  readonly set = (next: Partial<QueryState<T>>): void => {
    this.state = { ...this.state, ...next };
    for (const l of [...this.listeners]) l();
  };
}

/** Identity of a hook call: op, arguments (canonical, so key order does not matter) and the options that change the request. */
function callKey(op: string, args: Record<string, unknown>, o: OpOptions & { policy?: string; enabled?: boolean }): string {
  return `${RayfoldCache.resultKey(op, args, o.shape, o.vars)}|${JSON.stringify([o.policy, o.key, o.deadline, o.simulate, o.ifVersion, o.enabled])}`;
}

function cachedData<T>(client: RayfoldClient, op: string, args: Record<string, unknown>, o: OpOptions): T | undefined {
  const cached = client.cache.getResult(RayfoldCache.resultKey(op, args, o.shape, o.vars));
  return cached ? (client.cache.denormalize(cached.data) as T) : undefined;
}

/**
 * Runs a query and keeps the component in step with the cache: later commands (from any component) that patch
 * an entity in the result re-render it without a new request.
 */
export function useQuery<T = unknown>(op: string, args: Record<string, unknown> = {}, options: UseQueryOptions = {}): QueryResult<T> {
  const client = useRayfoldClient();
  const { enabled = true, ...query } = options;
  const key = callKey(op, args, options);
  const store = useMemo(
    () =>
      new Store<T>({ data: cachedData<T>(client, op, args, query), error: undefined, loading: enabled }, (set) =>
        enabled
          ? client.watch<T>(op, args, query, (data) => set({ data, error: undefined, loading: false }), (error) => set({ error, loading: false }))
          : () => {},
      ),
    // `key` stands for op, args and options
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, key],
  );
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const refetch = useCallback(async () => {
    try {
      const data = await client.query<T>(op, args, { ...query, policy: "network" });
      store.set({ data, error: undefined, loading: false });
    } catch (error) {
      store.set({ error, loading: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key, store]);
  return { ...state, refetch };
}

/**
 * A live query: the server pushes every change to the result, whoever made it. The subscription ends when the
 * component unmounts or the arguments change.
 */
export function useLive<T = unknown>(op: string, args: Record<string, unknown> = {}, options: UseLiveOptions = {}): QueryState<T> {
  const client = useRayfoldClient();
  const { enabled = true, ...live } = options;
  const key = callKey(op, args, options);
  const store = useMemo(
    () =>
      new Store<T>({ data: cachedData<T>(client, op, args, live), error: undefined, loading: enabled }, (set) =>
        enabled
          ? client.live<T>(op, args, live, (data) => set({ data, error: undefined, loading: false }), (error) => set({ error, loading: false }))
          : () => {},
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, key],
  );
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}

/**
 * A command, run on demand: `const [run, state] = useCommand<Order>("placeOrder")`. `run(args)` returns the result
 * and rejects on failure; the outcome also lands in `state`, so calling `run` without awaiting it is fine.
 * Each run gets a fresh idempotency key unless `options.key` is given.
 */
export function useCommand<T = unknown, A extends Record<string, unknown> = Record<string, unknown>>(
  op: string,
  options: CommandOptions = {},
): [run: (args: A, options?: CommandOptions) => Promise<T>, state: CommandState<T>] {
  const client = useRayfoldClient();
  const [state, setState] = useState<CommandState<T>>({ data: undefined, error: undefined, running: false });
  const latest = useRef(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // the options of the latest render: an `optimistic` function closes over props and state, which a key built from
  // the options (JSON drops functions) kept at their first render's values
  const latestOptions = useRef(options);
  latestOptions.current = options;
  const run = useCallback(
    (args: A, perCall: CommandOptions = {}): Promise<T> => {
      const n = ++latest.current;
      setState((s) => ({ ...s, error: undefined, running: true }));
      const result = client.command<T>(op, args, { ...latestOptions.current, ...perCall });
      // only the latest run speaks for the state; attaching handlers also keeps an ignored rejection handled
      result.then(
        (data) => {
          if (mounted.current && n === latest.current) setState({ data, error: undefined, running: false });
        },
        (error: unknown) => {
          if (mounted.current && n === latest.current) setState({ data: undefined, error, running: false });
        },
      );
      return result;
    },
    [client, op],
  );
  return [run, state];
}
