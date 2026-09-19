/**
 * Angular bindings for @rayfold/client. The client keeps a normalised cache and pushes to it, which is what a signal
 * wants: invalidate on push, compute on read. So a command's patch updates every component showing the same entity,
 * with no refetch and no re-render of anything else.
 *
 *   bootstrapApplication(App, { providers: [provideRayfold(client)] });
 *
 *   readonly book = injectQuery<Book>("book", () => ({ id: this.id() }));
 *   // template: @if (book.loading()) { ... } @else { {{ book.data()?.title }} }
 *
 * Arguments are a function so they can read signals: when `this.id()` changes the query re-runs and the old
 * subscription ends. Pass a plain object when nothing about the call changes.
 */
import { DestroyRef, InjectionToken, computed, effect, inject, signal, untracked, type Provider, type Signal } from "@angular/core";
import { RayfoldCache, type CommandOptions, type OpOptions, type QueryOptions, type RayfoldClient } from "@rayfold/client";

/** The client the injects below read. Provide it with {@link provideRayfold}. */
export const RAYFOLD_CLIENT = new InjectionToken<RayfoldClient>("RAYFOLD_CLIENT");

/** Makes `client` available to every `inject*` in the application. */
export function provideRayfold(client: RayfoldClient): Provider[] {
  return [{ provide: RAYFOLD_CLIENT, useValue: client }];
}

/** The provided client. Throws with a usable message when nothing provided one. */
export function injectRayfoldClient(): RayfoldClient {
  const client = inject(RAYFOLD_CLIENT, { optional: true });
  if (!client) throw new Error("Rayfold needs provideRayfold(client) in the application's providers");
  return client;
}

export interface QuerySignals<T> {
  /** The latest result. Starts as the cached result when this query ran before, while the fresh one loads. */
  readonly data: Signal<T | undefined>;
  /** The last failure (a RayfoldClientError for errors the server reported); cleared by the next result. */
  readonly error: Signal<unknown>;
  /** True until the first result or error for these arguments arrives. */
  readonly loading: Signal<boolean>;
}

export interface QueryHandle<T> extends QuerySignals<T> {
  /** Fetches again from the server, ignoring the cache. */
  refetch(): Promise<void>;
}

export interface CommandHandle<T, A extends Record<string, unknown>> {
  /** Runs the command. Returns its result and rejects on failure; the outcome also lands in the signals below. */
  run(args: A, options?: CommandOptions): Promise<T>;
  /** The last successful result. */
  readonly data: Signal<T | undefined>;
  /** The last failure; `error.is("OutOfStock")` narrows on a declared error type. */
  readonly error: Signal<unknown>;
  readonly running: Signal<boolean>;
}

export interface InjectQueryOptions extends QueryOptions {
  /** false: send nothing (until an id is known, say). Default true. A function is read reactively, like the arguments. */
  enabled?: Enabled;
}

export interface InjectLiveOptions extends OpOptions {
  /** false: do not subscribe. Default true. A function is read reactively, like the arguments. */
  enabled?: Enabled;
}

/** Arguments, or a function reading signals so the call re-runs when they change. */
export type Args = Record<string, unknown> | (() => Record<string, unknown>);

/** Whether to send anything at all: a function reading signals waits until they say so. */
export type Enabled = boolean | (() => boolean);

/** Arguments and whether they may be sent: the two things a call is re-made for. */
interface Call {
  args: Record<string, unknown>;
  on: boolean;
}

const read = (args: Args): Record<string, unknown> => (typeof args === "function" ? args() : args);
const reading = (args: Args, enabled: Enabled) => (): Call => ({ args: read(args), on: typeof enabled === "function" ? enabled() : enabled });

/**
 * Runs a query and keeps the component in step with the cache: a later command that patches an entity in the result
 * updates it without a new request.
 */
export function injectQuery<T = unknown>(op: string, args: Args = {}, options: InjectQueryOptions = {}): QueryHandle<T> {
  const client = injectRayfoldClient();
  const { enabled = true, ...query } = options;
  const call = reading(args, enabled);
  const state = signal<{ data: T | undefined; error: unknown; loading: boolean }>({ data: undefined, error: undefined, loading: false });
  let stop: (() => void) | undefined;
  let current: Record<string, unknown> = {};

  const subscribe = (next: Call): void => {
    stop?.();
    stop = undefined;
    current = next.args;
    if (!next.on) {
      state.set({ data: undefined, error: undefined, loading: false });
      return;
    }
    // what the cache already holds shows immediately, so a screen that has been here before does not blank
    state.set({ data: cached<T>(client, op, current, query), error: undefined, loading: true });
    stop = client.watch<T>(
      op,
      current,
      query,
      (data) => state.set({ data, error: undefined, loading: false }),
      (error) => state.update((s) => ({ ...s, error, loading: false })),
    );
  };

  // Subscribed now, not on the first change detection: a query should be in flight the moment it is injected, and
  // the caller should see `loading` immediately rather than one tick later.
  const first = call();
  subscribe(first);
  watchCall(args, enabled, call, first, subscribe);
  inject(DestroyRef).onDestroy(() => stop?.());

  return {
    data: computed(() => state().data),
    error: computed(() => state().error),
    loading: computed(() => state().loading),
    refetch: async () => {
      try {
        const data = await client.query<T>(op, current, { ...query, policy: "network" });
        state.set({ data, error: undefined, loading: false });
      } catch (error) {
        state.update((s) => ({ ...s, error, loading: false }));
      }
    },
  };
}

/**
 * A live query: the server pushes every change to the result, whoever made it. The subscription ends when the
 * injector is destroyed or the arguments change.
 */
export function injectLive<T = unknown>(op: string, args: Args = {}, options: InjectLiveOptions = {}): QuerySignals<T> {
  const client = injectRayfoldClient();
  const { enabled = true, ...live } = options;
  const call = reading(args, enabled);
  const state = signal<{ data: T | undefined; error: unknown; loading: boolean }>({ data: undefined, error: undefined, loading: false });
  let stop: (() => void) | undefined;

  const subscribe = (next: Call): void => {
    stop?.();
    stop = undefined;
    if (!next.on) {
      state.set({ data: undefined, error: undefined, loading: false });
      return;
    }
    state.set({ data: cached<T>(client, op, next.args, live), error: undefined, loading: true });
    stop = client.live<T>(
      op,
      next.args,
      live,
      (data) => state.set({ data, error: undefined, loading: false }),
      (error) => state.update((s) => ({ ...s, error, loading: false })),
    );
  };

  const first = call();
  subscribe(first);
  watchCall(args, enabled, call, first, subscribe);
  inject(DestroyRef).onDestroy(() => stop?.());

  return {
    data: computed(() => state().data),
    error: computed(() => state().error),
    loading: computed(() => state().loading),
  };
}

/**
 * A command, run on demand. Each run gets a fresh idempotency key unless `options.key` says otherwise, so a retry
 * replays rather than running twice.
 */
export function injectCommand<T = unknown, A extends Record<string, unknown> = Record<string, unknown>>(
  op: string,
  options: CommandOptions = {},
): CommandHandle<T, A> {
  const client = injectRayfoldClient();
  const state = signal<{ data: T | undefined; error: unknown; running: boolean }>({ data: undefined, error: undefined, running: false });
  let latest = 0;
  let alive = true;
  inject(DestroyRef).onDestroy(() => (alive = false));

  return {
    run: (args: A, perCall: CommandOptions = {}): Promise<T> => {
      const n = ++latest;
      state.update((s) => ({ ...s, error: undefined, running: true }));
      const result = client.command<T>(op, args, { ...options, ...perCall });
      // only the newest run speaks for the state; attaching handlers also keeps an ignored rejection handled
      result.then(
        (data) => {
          if (alive && n === latest) state.set({ data, error: undefined, running: false });
        },
        (error: unknown) => {
          if (alive && n === latest) state.set({ data: undefined, error, running: false });
        },
      );
      return result;
    },
    data: computed(() => state().data),
    error: computed(() => state().error),
    running: computed(() => state().running),
  };
}

/**
 * Re-runs [onChange] when a function form of the arguments, or of `enabled`, produces something different.
 *
 * The first subscription already happened, so the effect's own first run only establishes which signals were read.
 * A call that did not change is ignored, since an effect can run for reasons of its own.
 */
function watchCall(args: Args, enabled: Enabled, call: () => Call, initial: Call, onChange: (next: Call) => void): void {
  if (typeof args !== "function" && typeof enabled !== "function") return;
  let seen = JSON.stringify(initial);
  effect(() => {
    const next = call();
    const key = JSON.stringify(next);
    if (key === seen) return;
    seen = key;
    untracked(() => onChange(next));
  });
}

function cached<T>(client: RayfoldClient, op: string, args: Record<string, unknown>, o: OpOptions): T | undefined {
  const hit = client.cache.getResult(RayfoldCache.resultKey(op, args, o.shape, o.vars));
  return hit ? (client.cache.denormalize(hit.data) as T) : undefined;
}
