# @rayfold/angular

Angular bindings for [Rayfold](https://rayfold.dev): `injectQuery`, `injectLive` and `injectCommand`, returning
signals.

```sh
npm install @rayfold/angular @rayfold/client
```

The client keeps a normalised cache and pushes to it, which is what a signal wants: invalidate on push, compute on
read. So when a command changes a book, every component showing that book updates - nothing is fetched again, and
components showing other books do not recompute.

```ts
bootstrapApplication(App, { providers: [provideRayfold(client)] });
```

```ts
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (book.loading()) { <p>Loading...</p> } @else { <h2>{{ book.data()?.title }}</h2> }`,
})
export class BookCard {
  readonly id = input.required<string>();
  readonly book = injectQuery<Book>("book", () => ({ id: this.id() }), { shape: "{ id title stock }" });
  readonly restock = injectCommand<Book>("restock");
}
```

| | |
|---|---|
| `provideRayfold(client)` | Makes the client available to every inject below it. |
| `injectQuery(op, args?, options?)` | `data`, `error`, `loading` signals, plus `refetch()`. In flight the moment it is injected. |
| `injectLive(op, args?, options?)` | The same signals, kept current by the server whoever changes the data. |
| `injectCommand(op, options?)` | `run(args)`, plus `data`, `error` and `running` signals. |
| `injectRayfoldClient()` | The client itself, for `batch()` and `upload()`. |

Arguments may be a function so they can read signals: when what they read changes, the call re-runs and the previous
subscription ends.

A query that fails after it answered keeps its last `data` beside `error`; a command's `data` is the result of its
latest run, so a run that fails clears it. Queries and live queries keep the application unstable until their first
answer, and a command while it runs, so `fixture.whenStable()` and server rendering wait for the data.

> **Next release.** Holding the application unstable until the first answer is not in 0.2.1; it arrives in the next
> release.

Needs Angular 19 or newer. No zone. [Guide](https://rayfold.dev/guide/angular).

Apache-2.0.
