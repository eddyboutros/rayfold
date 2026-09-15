# Bookshop in TypeScript

A Rayfold server and client on Node.js. The same bookshop is built in every example folder, so you can compare
stacks line by line.

- `src/bookshop.rayfold`: the schema
- `src/bookshop.ts`: data, resolvers, who the caller is, and the HTTP server
- `src/server.ts`: starts it on port 4000
- `src/client.ts`: reads a book, buys a copy, handles a sold-out book
- `src/bookshop.test.ts`: the same flows as tests

## Run it

Node.js 22 or later. From this folder:

```sh
npm install
npm run server
```

Then, in a second terminal:

```sh
npm run client
```

Or call it with curl:

```sh
curl -s localhost:4000/rayfold -H 'content-type: application/rayfold+json' -H 'rayfold-safe: true' \
  -d '{"rayfold":"0.1","ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ title stock author { name } }"}]}'
```

The explorer is at http://localhost:4000/rayfold/explorer. Paste `Bearer customer` or `Bearer staff` as the token to
try the commands.
