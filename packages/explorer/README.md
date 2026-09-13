# @rayfold/explorer

The page a [Rayfold](https://github.com/eddyboutros/rayfold) server serves next to its endpoint: the counterpart of
Swagger UI and GraphiQL. It reads the server's manifest, so it shows what the schema actually says rather than a copy
that can drift.

```sh
npm install @rayfold/explorer
```

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

Nothing is served unless you mount it. The explorer talks to the endpoint as a browser client: what a visitor can read
through it is exactly what the endpoint's own policies allow for the token they paste into it, and no more. On a public
deployment, mount it behind the same authentication as the rest of your administration pages, or only in development:

```ts
if (process.env.NODE_ENV !== "production") app.use(createExplorerHandler());
```

`explorerHtml(options)` returns the same page as a string, for serving it from a framework of your own.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `endpoint` | `/rayfold` | Where the page sends its batches, and where it reads the manifest. |
| `path` | `<endpoint>/explorer` | Where the page itself is served. |
| `title` | `Rayfold` | Shown in the header, to tell one service from another. |

Apache-2.0.
