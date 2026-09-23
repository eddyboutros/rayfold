# Bookshop in TypeScript

A Rayfold server and client on Node.js. The same bookshop is built in every example folder, so you can compare
stacks line by line.

- `src/bookshop.rayfold`: the schema
- `src/resolvers.ts`: the data and the resolvers
- `src/auth.ts`: who the caller is, from a signed token (JWT) the identity provider issued
- `src/token.ts`: prints a development token (`npm run token`)
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

The explorer is at http://localhost:4000/rayfold/explorer.

## Signing in

The server believes who a caller is only from a token whose signature it can check. With no identity provider
configured it signs and checks tokens with a development key, and prints one on request:

```sh
curl -s localhost:4000/rayfold -H 'content-type: application/rayfold+json' \
  -H "authorization: Bearer $(npm run -s token -- staff)" \
  -d '{"rayfold":"0.1","ops":[{"id":1,"op":"book","args":{"id":"b3"},"shape":"{ title costPrice }"}]}'
```

`npm run token` signs a customer's token, who may buy; `npm run token -- staff` a member of staff's, who may also
restock and see `costPrice`. Without a token you can only read. In the explorer, paste the token into the auth field.

In production, point the server at your identity provider instead, and the development key is never used:

```sh
AUTH_JWKS_URL=https://your-tenant.example/.well-known/jwks.json AUTH_ISSUER=https://your-tenant.example/ npm run server
```

It then accepts tokens that provider signed for the audience `bookshop`, and reads the caller's role from their
`role` claim.
