# @rayfold/server

The Rayfold server for Node.js. Give it a schema and resolvers. It serves batches with pipelining, applies the
policies, costs and cache rules the schema declares, pushes live-query updates, and can expose REST bindings,
OpenAPI 3.2 and an MCP endpoint from the same schema.

```sh
npm install @rayfold/server
```

```ts
import { createRayfoldServer, listen } from "@rayfold/server";

interface Book { id: string; title: string; stock: number }
const books = new Map<string, Book>([["b1", { id: "b1", title: "Dune", stock: 3 }]]);

const server = createRayfoldServer({
  schema: `
    entity Book {
      id: ID
      title: String
      stock: Int
    }
    query book(id: ID): Book?
    command restock(id: ID, qty: Int): Book
  `,
  resolvers: {
    Query: {
      book: ({ id }: { id: string }) => books.get(id) ?? null,
    },
    Command: {
      // The returned entity becomes a cache patch, so every client showing Book:b1 updates without refetching.
      restock: ({ id, qty }: { id: string; qty: number }) => {
        const book = books.get(id);
        if (!book) throw new Error(`no book ${id}`);
        book.stock += qty;
        return book;
      },
    },
  },
});

// Commands need a signed-in viewer: turn the request into one (here, a fixed demo token).
await listen(server, 4000, {
  viewer: (req) => (req.headers.authorization === "Bearer demo" ? { id: "demo-user" } : null),
});
```

`POST /rayfold` now answers batches:

```sh
curl -s localhost:4000/rayfold -H 'content-type: application/rayfold+json' -H 'rayfold-safe: true' \
  -d '{"rayfold":"0.1","ops":[{"id":1,"op":"book","args":{"id":"b1"}}]}'
```

What else is in the package:

| Export | What it does |
|---|---|
| `createHttpHandler(server, options)` | The same endpoint as a plain `(req, res)` handler for your own `http` server, Express or Fastify. |
| `attachWebSocket(server, httpServer)` | Batches and live queries over one WebSocket. |
| `createBindingHandler(server)` | REST routes from `@http(...)` annotations in the schema. |
| `openApiFor(server)` | An OpenAPI 3.2 document for those routes. |
| `createMcpHandler(server)` | The schema as an MCP server: commands become tools, queries become resources. |
| `MemoryIdempotencyStore` | Where command results are kept so a retry replays instead of running the command again. |

Running more than one server: pass `idempotency` a store every instance shares, such as `PgIdempotencyStore` from
`@rayfold/postgres`, and a keyed command runs once across the fleet. `idempotencyLeaseMs` (default 30 seconds) is how
long a server holds a key before another may take it over.

Security defaults: JSON-only bodies, an Origin check on state-changing requests, a Host check on loopback servers,
a 1 MiB body limit, nesting and cost limits, and a redacted manifest. See `spec/12-security.md` in the Rayfold
repository.

Apache-2.0.
