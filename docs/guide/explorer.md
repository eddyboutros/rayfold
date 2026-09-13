# The explorer

`@rayfold/explorer` is the page a Rayfold server serves next to its endpoint: the counterpart of Swagger UI and
GraphiQL. It reads the server's manifest, so it shows what the schema actually says rather than a copy that can drift.

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
});
```

The page lists every operation with its arguments, what it returns, what it costs and which policies guard it; fills
in a request with a shape that selects the scalar fields of the result, as a starting point; sends the batch to the
endpoint like any other client; and shows the frames as they arrive, each with its cost. A command that allows
`@simulate` can be run as a **dry run**, which reports what would happen and writes nothing. A query can be sent
`live`, and the frames keep arriving as the data changes.

It is one self-contained document: no fonts, scripts or styles from anywhere else, so it works behind a strict
`Content-Security-Policy` and with no network beyond your own server.

## Where it is served, and to whom

Nothing is served unless you mount it, so the explorer exists only where you put it. It talks to the endpoint as a
browser client: what a visitor can read through it is exactly what the endpoint's own policies allow for the token
they paste into it, and no more. On a public deployment, mount it behind the same authentication as the rest of your
administration pages, or only in development:

```ts
if (process.env.NODE_ENV !== "production") app.use(createExplorerHandler());
```

`explorerHtml(options)` returns the same page as a string, for serving it from a framework of your own.

## In development

`rayfold dev` serves it at `/rayfold/explorer`, and sends the root there:

```sh
npm run rayfold -- dev examples/bookstore-ts
```

## On the JVM

The JVM serves the same page, character for character; `npm run sync:explorer` copies it across, and a test fails if
the two ever drift. Mount it on a server of its own:

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
