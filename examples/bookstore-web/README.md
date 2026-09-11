# Rayfold web demo

The bookstore with the real Project Gutenberg catalogue (see `data/README.md`), used from a real browser through the
real `@rayfold/client`.

```
npm run demo
```

| URL | What it is |
|---|---|
| http://localhost:4610 | The app: search the catalogue, open a book, buy it, pay for it. Stock updates live over WebSocket. |
| http://localhost:4611 | Another website. Its page tries to act on the demo with the visitor's cookie. Every attempt must fail. |
| http://localhost:4612 | A reverse proxy that rewrites Host, as nginx `proxy_pass` does by default. |

## Behind a proxy

Behind a reverse proxy that rewrites Host, the browser's Origin no longer matches the Host the server sees. Rayfold then
refuses writes with 403. That is the Origin rule doing its job, not a bug. List the public origin:

```
RAYFOLD_ALLOWED_ORIGINS=http://localhost:4612 npm run demo
```

`nginx.conf` holds the same setup for a real nginx:

```
docker run --rm -p 8080:8080 -v "$PWD/examples/bookstore-web/nginx.conf:/etc/nginx/nginx.conf:ro" nginx:1.27-alpine
RAYFOLD_DEMO_HOST=0.0.0.0 RAYFOLD_ALLOWED_ORIGINS=http://localhost:8080 npm run demo
```

Binding to 0.0.0.0 exposes the demo on your network; do it only on a machine you trust.
