# React

`@rayfold/react` connects components to the Rayfold client's cache. When a command changes a book, every component
showing that book re-renders with the new value. Nothing is fetched again, and components showing other books do not
re-render. It works with React 18 and 19.

```sh
npm install @rayfold/react @rayfold/client
```

## Provide the client

```tsx
import { RayfoldClient, createFetchTransport } from "@rayfold/client";
import { RayfoldProvider } from "@rayfold/react";

const client = new RayfoldClient({
  transport: createFetchTransport({ url: "/rayfold", headers: () => ({ authorization: `Bearer ${token()}` }) }),
});

export function App() {
  return (
    <RayfoldProvider client={client}>
      <BookPage id="b1" />
    </RayfoldProvider>
  );
}
```

## Read with `useQuery`

```tsx
import { useQuery } from "@rayfold/react";

interface Book { id: string; title: string; stock: number; author: { name: string } }

function BookPage({ id }: { id: string }) {
  const { data, error, loading, refetch } = useQuery<Book>("book", { id }, { shape: "{ id title stock author { name } }" });
  if (error) return <p>Could not load the book. <button onClick={() => refetch()}>Try again</button></p>;
  if (loading && !data) return <p>Loading…</p>;
  return <h1>{data?.title} by {data?.author.name}: {data?.stock} left</h1>;
}
```

- `shape` picks the fields. Without it the type's default view is used.
- `loading` is true until the first result. When the same query ran before, `data` holds the cached result at once
  while the fresh one loads.
- `enabled: false` sends nothing, for example until an id is known.
- `policy: "cache"` uses a fresh cached result instead of asking the server.

## Change with `useCommand`

```tsx
import { useCommand } from "@rayfold/react";
import type { RayfoldClientError } from "@rayfold/client";

function BuyButton({ id }: { id: string }) {
  const [buy, { running, error }] = useCommand<Book>("buy");
  const e = error as RayfoldClientError | undefined;
  return (
    <>
      <button disabled={running} onClick={() => buy({ id, qty: 1 })}>Buy</button>
      {e?.is("OutOfStock") && <p>Only {(e.data as { available: number }).available} left.</p>}
    </>
  );
}
```

`buy(...)` returns a promise that rejects on failure, and the outcome also lands in the hook's state. Calling it
without `await`, as above, is fine. Each call gets its own idempotency key, so a retried request never buys twice.

## Follow other people's changes with `useLive`

```tsx
import { useLive } from "@rayfold/react";

function StockBadge({ id }: { id: string }) {
  const { data } = useLive<{ stock: number }>("book", { id }, { shape: "{ id stock }" });
  return <span>{data?.stock ?? "…"} in stock</span>;
}
```

The server pushes every change to the result, whoever made it. The subscription ends when the component unmounts.
Over HTTP the TypeScript server streams live queries on the request; to share one connection between many, give the
client `createWebSocketTransport({ url: "wss://…/rayfold/ws" })`.

## Server rendering

On the server the hooks render their loading state and send nothing, so `renderToString` works as is. The browser
fetches after hydration.
