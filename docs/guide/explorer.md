# The explorer

`@rayfold/explorer` is the page a Rayfold server serves next to its endpoint: the counterpart of Swagger UI and
GraphiQL. It reads the server's manifest, so it shows the schema the server is running, not a copy that can drift.

```ts
import { createServer } from "node:http";
import { createHttpHandler } from "@rayfold/server";
import { createExplorerHandler } from "@rayfold/explorer";

const endpoint = createHttpHandler(server, { viewer });
const explorer = createExplorerHandler({ endpoint: "/rayfold", title: "Acme API" });

createServer((req, res) => {
  if (explorer(req, res)) return;          // serves /rayfold/explorer
  if ((req.url ?? "").startsWith("/rayfold")) return endpoint(req, res);
  res.writeHead(404).end();
}).listen(4000);
```

The page lists every operation with its arguments, what it returns, what it costs and which policies guard it, and
fills in a request for the one you pick, with a shape that selects the scalar fields of the result as a starting point.
From there:

| | |
|---|---|
| **Writing** | Ctrl+Space, or typing, suggests what fits at the cursor: op names, an op's arguments, and the fields of the type a shape is selecting there, a union's members included. Before anything is sent, the manifest's checks name an unknown op, argument or field with the nearest real one, a missing argument, and a command without an idempotency key. They never block a send; the server decides. |
| **Shape** | Ticking fields and union members builds the shape, a level down too. An alias, arguments and modifiers stay as they were written. |
| **Sending** | Send turns into **Stop** while a request runs, so a `live` query can be ended and the op ends on the server. A command that allows `@simulate` can be run as a **dry run**, which reports what would happen and writes nothing. **Headers** are sent beside the token. **Copy as curl** gives the same request for a terminal. |
| **Reading** | Every response shows its HTTP status, size and time. **Frames** shows them as they arrive, each with its cost; **Result** shows what they add up to, patches applied the way a client cache applies them ([spec 13](../../spec/13-patches.md)). A body that is not Rayfold frames, such as a proxy's error page, shows as text under its status. |
| **Keeping** | Requests live in tabs, and the last fifty sends in a history; both come back when the page is opened again. The token and headers are kept only when you tick the box that says so. Where the browser refuses storage, the page works the same and keeps nothing. |

::: info Since 0.2.3
0.2.2 lists the operations, fills in a request, runs a dry run, and shows the frames as they arrive with their cost.
The rest of the table arrived in 0.2.3. In 0.2.2 a live query stops only when you reload the page, the request is a
plain text box, and a response shows how many frames came and how long they took, with no status or size.
:::

The operations come from the endpoint's manifest, so a server with `manifest: "off"` has nothing to list, and the page
says there is no manifest.

It is one self-contained document: nothing loads from any other origin, so it works offline and on a closed network.
Its script and styles are inline, so where a `Content-Security-Policy` applies, its path needs `'unsafe-inline'` for
`script-src` and `style-src`.

## Where it is served, and to whom

Nothing is served unless you mount it. The explorer talks to the endpoint as a browser client: a visitor can read
through it exactly what the endpoint's own policies allow for the token they paste into it. On a public deployment, mount it behind the same authentication as the rest of your
administration pages, or only in development:

```ts
// The handler answers its own path and returns false for anything else, so pass the rest along yourself.
if (process.env.NODE_ENV !== "production") {
  const explorer = createExplorerHandler();
  app.use((req, res, next) => {
    if (!explorer(req, res)) next();
  });
}
```

`explorerHtml(options)` returns the same page as a string, for serving it from a framework of your own.

## In development

`rayfold dev` serves it at `/rayfold/explorer`, and sends the root there:

```sh
npm run rayfold -- dev examples/bookstore-ts
```

## On the JVM

The JVM serves the same page, character for character. `npm run sync:explorer` copies it across, and a test fails if
the two drift. Mount it on a server of its own:

```kotlin
val http = HttpServer.create(InetSocketAddress(8080), 0)
RayfoldExplorer(endpoint = "/rayfold", title = "Acme API").mount(http)   // serves /rayfold/explorer
```

or turn it on next to the endpoint, where it is configured for whatever path the endpoint is mounted at:

```kotlin
RayfoldHttp(server, HttpOptions(explorer = true, explorerTitle = "Acme API")).start(8080)
```

In Spring Boot it is a property, and the page sits behind the application's security like the endpoint itself:

```properties
rayfold.explorer.enabled=true
rayfold.explorer.title=Acme API
```
