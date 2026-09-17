# Quickstart

A Rayfold server and client in Node.js, in about five minutes. You need Node.js 22 or later.

## 1. Install

```sh
mkdir bookshop && cd bookshop
npm init -y
npm pkg set type=module
npm install @rayfold/server @rayfold/client
npm install --save-dev @rayfold/cli tsx
```

## 2. Write the schema

`schema.rayfold`:

```
entity Book {
  id: ID
  title: String
  stock: Int
}

query book(id: ID): Book?
command restock(id: ID, qty: Int): Book
```

Fields are non-null unless marked with `?`. Check it:

```sh
npx rayfold check schema.rayfold
```

## 3. Write the server

`server.ts`:

```ts
import { readFileSync } from "node:fs";
import { createRayfoldServer, listen } from "@rayfold/server";

interface Book { id: string; title: string; stock: number }
const books = new Map<string, Book>([["b1", { id: "b1", title: "Dune", stock: 3 }]]);

const server = createRayfoldServer({
  schema: readFileSync("schema.rayfold", "utf8"),
  resolvers: {
    Query: {
      book: ({ id }: { id: string }) => books.get(id) ?? null,
    },
    Command: {
      // The returned entity becomes a cache patch for every client showing Book:b1.
      restock: ({ id, qty }: { id: string; qty: number }) => {
        const book = books.get(id);
        if (!book) throw new Error(`no book ${id}`);
        book.stock += qty;
        return book;
      },
    },
  },
});

// Commands need a signed-in viewer. Here a fixed demo token stands in for your real authentication.
await listen(server, 4000, {
  viewer: (req) => (req.headers.authorization === "Bearer demo" ? { id: "demo-user" } : null),
});
console.log("Rayfold on http://localhost:4000/rayfold");
```

Run it:

```sh
npx tsx server.ts
```

## 4. Call it

With curl, a query is a JSON batch. `rayfold-safe: true` marks it as a read:

```sh
curl -s localhost:4000/rayfold -H 'content-type: application/rayfold+json' -H 'rayfold-safe: true' \
  -d '{"rayfold":"0.1","ops":[{"id":1,"op":"book","args":{"id":"b1"}}]}'
```

With the client, `client.ts`:

```ts
import { RayfoldClient, createFetchTransport } from "@rayfold/client";

interface Book { id: string; title: string; stock: number }

const client = new RayfoldClient({
  transport: createFetchTransport({
    url: "http://localhost:4000/rayfold",
    headers: () => ({ authorization: "Bearer demo" }),
  }),
});

const book = await client.query<Book>("book", { id: "b1" });
console.log(book.title, book.stock);

// watch() calls back with the book now, and again whenever the cached book changes - the restock reaches it
// through the command's own patch, with no refetch. Wait for that first call before commanding, or the
// command can land while the watch is still loading.
let stop = () => {};
await new Promise<void>((loaded) => {
  stop = client.watch<Book>("book", { id: "b1" }, {}, (b) => {
    console.log("stock is now", b.stock);
    loaded();
  });
});
await client.command("restock", { id: "b1", qty: 5 });
stop();
```

```sh
npx tsx client.ts
```

## 5. Next steps

- **Types.** `npx rayfold gen ts schema.rayfold --out schema.ts` writes TypeScript types for the schema. Or define the
  schema in TypeScript with `@rayfold/builder` and get the types inferred.
- **Fields from other data.** Add `author: Author` to `Book` and a loader
  `Book: { author: (books) => books.map((b) => authors.get(b.authorId)) }`. It runs once per level, for all books.
- **Rules.** `@allow(read: viewer.role == "admin")` on a field or type, `@cost(base: 5, perItem: 1)` on a query,
  `@cache(maxAge: 60s, scope: public)` on an entity.
- **Before there are resolvers.** `npx rayfold mock schema.rayfold` serves the schema with data the schema itself
  describes, and the explorer beside it, so screens can be built first; the same call always gives the same answer.
  When something is wrong, `npx rayfold check schema.rayfold` points at the line and says what it probably should be.
- **Are the resolvers complete?** `npx rayfold check schema.rayfold --resolvers ./src/resolvers.ts` checks that every
  operation is wired and that every field taking arguments has a loader, so a missing one is a failed build rather
  than a failed request. `checkWiring(server.ir, resolvers)` from `@rayfold/server` is the same check, for your own
  test suite.
- **Before production.** Serve over TLS, list your web app's origin in `allowedOrigins`, turn on `trustedShapes` to
  accept only registered shapes, and put rate limits in front. The [security chapter](../../spec/12-security.md)
  lists every default. Running more than one server takes a few shared stores: [Deployment](deployment.md).
- **React:** [React guide](react.md). **Kotlin or Android:** [Kotlin guide](kotlin.md). **Java or Spring Boot:**
  [Java guide](java-spring.md). **Workers, Hono, Bun, Deno or Next.js:** [Runtimes](runtimes.md).
- **Sending files.** A file goes up its own route and a command names what arrived: [Uploads](uploads.md).
