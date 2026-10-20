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

The page lists every operation with its arguments, what it returns, what it costs and which policies guard it, and
fills in a request for the one you pick, with a shape that selects the scalar fields of the result as a starting point.
From there:

| | |
|---|---|
| **Writing** | Ctrl+Space, or typing, suggests what fits at the cursor: op names, an op's arguments, and the fields of the type a shape is selecting there, a union's members included. Before anything is sent, the manifest's checks name an unknown op, argument or field with the nearest real one, a missing argument, and a command without an idempotency key. They never block a send: the server is the judge. |
| **Shape** | Ticking fields and union members builds the shape, a level down too. An alias, arguments and modifiers stay as they were written. |
| **Sending** | Send turns into **Stop** while a request runs, so a `live` query can be ended and the op ends on the server. A command that allows `@simulate` can be run as a **dry run**, which reports what would happen and writes nothing. **Headers** are sent beside the token. **Copy as curl** gives the same request for a terminal. |
| **Reading** | Every response shows its HTTP status, size and time. **Frames** shows them as they arrive, each with its cost; **Result** shows what they add up to, patches applied the way a client cache applies them ([spec 13](https://github.com/eddyboutros/rayfold/blob/main/spec/13-patches.md)). A body that is not Rayfold frames, such as a proxy's error page, shows as text under its status. |
| **Keeping** | Requests live in tabs, and the last fifty sends in a history; both come back when the page is opened again. The token and headers are kept only when you tick the box that says so. Where the browser refuses storage, the page works the same and keeps nothing. |

> **Next release.** The table above comes with the next release, except the dry run, the bearer token and the frames
> as they arrive with their cost and time. In 0.2.2 the page lists the operations and fills in a request for the one
> you pick, but the request is a plain text box, a live query cannot be stopped except by reloading the page, and
> nothing is kept between visits.

It is one self-contained document: no fonts, scripts or styles from anywhere else, so it works offline and with no
network beyond your own server. Its script and styles are inline, so where a `Content-Security-Policy` applies, its
path needs `'unsafe-inline'` for `script-src` and `style-src`.

## Where it is served, and to whom

Nothing is served unless you mount it. The explorer talks to the endpoint as a browser client: what a visitor can read
through it is exactly what the endpoint's own policies allow for the token they paste into it, and no more. On a public
deployment, mount it behind the same authentication as the rest of your administration pages, or only in development:

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

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `endpoint` | `/rayfold` | Where the page sends its batches, and where it reads the manifest. |
| `path` | `<endpoint>/explorer` | Where the page itself is served. |
| `title` | `Rayfold` | Shown in the header, to tell one service from another. |

Apache-2.0.
