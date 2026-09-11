# @rayfold/react

React hooks for Rayfold. Components read through `@rayfold/client`'s cache, so when a command changes a book,
every component showing that book re-renders with the new value, without fetching it again.

```sh
npm install @rayfold/react @rayfold/client react
```

```tsx
import { RayfoldClient, createFetchTransport } from "@rayfold/client";
import { RayfoldProvider, useQuery, useCommand, useLive } from "@rayfold/react";

interface Book { id: string; title: string; stock: number }

const client = new RayfoldClient({ transport: createFetchTransport({ url: "/rayfold" }) });

export function App() {
  return (
    <RayfoldProvider client={client}>
      <BookCard id="b1" />
    </RayfoldProvider>
  );
}

function BookCard({ id }: { id: string }) {
  const { data, error, loading } = useQuery<Book>("book", { id });
  const [restock, restocking] = useCommand<Book>("restock");

  if (error) return <p>Could not load the book.</p>;
  if (loading && !data) return <p>Loading…</p>;
  return (
    <p>
      {data?.title}: {data?.stock} in stock
      <button disabled={restocking.running} onClick={() => restock({ id, qty: 5 })}>Restock</button>
    </p>
  );
}

// Changes made by other people, pushed by the server:
function LiveStock({ id }: { id: string }) {
  const { data } = useLive<Book>("book", { id }, { shape: "{ id stock }" });
  return <span>{data?.stock}</span>;
}
```

| Hook | Returns |
|---|---|
| `useQuery(op, args, options)` | `{ data, error, loading, refetch }`. `options` takes a `shape`, `policy: "cache"` to use a fresh cached result, and `enabled: false` to wait. Re-renders when the cache changes. |
| `useLive(op, args, options)` | `{ data, error, loading }`, kept current by the server. Unsubscribes on unmount. |
| `useCommand(op, options)` | `[run, { data, error, running }]`. `run(args)` returns a promise; the outcome also lands in the state, so an unawaited `run` is safe. `error.is("OutOfStock")` narrows on a declared error. |
| `useRayfoldClient()` | The client, for anything else (batches, streams). |

Server rendering renders the loading state and sends no request; the browser fetches after hydration. Works with
React 18 and 19.

Apache-2.0.
