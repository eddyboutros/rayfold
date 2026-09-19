---
title: Angular
description: injectQuery, injectLive and injectCommand return signals, so a command's patch updates every component showing that entity with no refetch.
---

# Angular

::: warning New in 0.2.0, which is not published yet
`@rayfold/angular` is in the repository, tested, and documented here, but it is not on npm. The install below will
not find it until 0.2.0 ships — see [versioning](../versioning.md).
:::

`@rayfold/angular` connects components to the Rayfold client's cache. When a command changes a book, every component
showing that book updates with the new value — nothing is fetched again, and components showing other books do not
recompute. It needs Angular 19 or newer, and no zone.

```sh
npm install @rayfold/angular @rayfold/client
```

The fit is close to exact. The client keeps a normalised cache and **pushes** to it; a signal invalidates on push and
computes on read. So the binding is thin: these are the client's own subscriptions, exposed as signals.

## Provide the client

```ts
import { bootstrapApplication } from "@angular/platform-browser";
import { RayfoldClient, createFetchTransport } from "@rayfold/client";
import { provideRayfold } from "@rayfold/angular";

const client = new RayfoldClient({
  transport: createFetchTransport({ url: "/rayfold", headers: () => ({ authorization: `Bearer ${token()}` }) }),
});

bootstrapApplication(App, { providers: [provideRayfold(client)] });
```

## Read with `injectQuery`

```ts
@Component({
  selector: "book-card",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (book.loading()) { <p>Loading…</p> }
    @else if (book.error()) { <p>Could not load it.</p> }
    @else { <h2>{{ book.data()?.title }}</h2><p>{{ book.data()?.stock }} in stock</p> }
  `,
})
export class BookCard {
  readonly id = input.required<string>();
  readonly book = injectQuery<Book>("book", () => ({ id: this.id() }), { shape: "{ id title stock }" });
}
```

Two things worth knowing:

**The arguments are a function**, so they can read signals. When `id()` changes the query re-runs and the previous
subscription ends. Pass a plain object when nothing about the call changes.

**The query is in flight the moment it is injected**, not on the first change detection, so `loading()` is true
immediately and a template never paints an empty state it should not.

`refetch()` goes back to the server and ignores the cache. `enabled: false` sends nothing, for a query that has to
wait for an id — and like the arguments it may be a function, so the query starts by itself once the id arrives:

```ts
readonly book = injectQuery<Book>("book", () => ({ id: this.id() }), { enabled: () => this.id() !== "" });
```

## Change with `injectCommand`

```ts
export class RestockButton {
  readonly restock = injectCommand<Book>("restock");

  run(id: string) {
    this.restock.run({ id, qty: 5 });   // returns a promise; the outcome also lands in the signals
  }
}
```

```html
<button (click)="run(id())" [disabled]="restock.running()">Restock</button>
@if (restock.error(); as e) { <p>{{ e.message }}</p> }
```

Each run gets a fresh idempotency key unless you pass one, so a retry replays rather than running twice. The command's
patches reach the cache, so every query showing that book updates — including ones in components that know nothing
about this button.

## Follow other people's changes with `injectLive`

```ts
readonly book = injectLive<Book>("book", () => ({ id: this.id() }), { shape: "{ id title stock }" });
```

Same signals, except the server pushes every change to the result, whoever made it. The subscription ends when the
component is destroyed or the arguments change. Give the client a WebSocket transport to share one connection between
many live queries — see [Live updates](../learn/live.md).

## Why signals rather than RxJS

The client is not a stream of requests; it is a cache that changes. An `Observable` would model "the next value
arrives" when what is actually true is "this value is now stale, recompute when someone reads it" — which is what a
signal is. If you need an observable at the edge of an existing RxJS codebase, `toObservable` from `@angular/core/rxjs-interop`
converts any of these signals.

## Next

- [Live updates](../learn/live.md) — what the server sends and when.
- [Caching](../learn/caching.md) — the cache these signals read.
- [Offline and optimistic](./offline.md) — queueing commands and showing a change before the server confirms it.
