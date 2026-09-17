# Bookshop in TypeScript

A Rayfold server and client on Node.js. The same bookshop is built in every example folder, so you can compare
stacks line by line.

- `src/bookshop.rayfold`: the schema
- `src/resolvers.ts`: the data, the resolvers, and who the caller is
- `src/bookshop.ts`: builds the server from those and puts the explorer beside it
- `src/server.ts`: starts it on port 4000
- `src/client.ts`: reads a book, buys a copy, handles a sold-out book
- `src/bookshop.test.ts`: the same flows as tests
- `src/copies.test.ts`: proves every stack's copy of the schema is byte for byte the same

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

The explorer is at http://localhost:4000/rayfold/explorer. To sign in there, type `customer` or `staff` in the auth
field: the explorer adds the `Bearer` itself.
