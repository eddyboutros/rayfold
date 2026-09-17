---
title: TypeScript
description: A Rayfold server and client on Node.js, step by step.
---

<StackNav current="typescript" />

# Get started with TypeScript

A bookshop server with four operations, and a client that reads a book, buys a copy and handles a sold-out title.
The finished project is [examples/typescript](../../examples/typescript). You need Node.js 22 or later.

## 1. Create the project

```sh
mkdir bookshop && cd bookshop
npm init -y
npm pkg set type=module
npm install @rayfold/server @rayfold/client @rayfold/explorer
npm install --save-dev tsx @rayfold/cli
```

## 2. Describe the API

Save the schema as `src/bookshop.rayfold`:

<<< @/../examples/typescript/src/bookshop.rayfold

Check it whenever you change it. A mistake is reported with its line and what was probably meant:

```sh
npx rayfold check src/bookshop.rayfold
```

## 3. Write the resolvers

`src/resolvers.ts`, after the data and types (see the [whole file](../../examples/typescript/src/resolvers.ts)):

<<< @/../examples/typescript/src/resolvers.ts#resolvers{ts}

- `Query` and `Command` have one function per operation, named as in the schema. Arguments arrive already checked
  against it, `@range` included.
- `Book.author` is a loader. It receives every book in the result at once and returns their authors in the same
  order, so a page of 50 books looks up authors once.
- `RayfoldError.domain("OutOfStock", ...)` is the error the schema declared. The client receives it by name, with
  its data.
- `ok(book, { emit })` returns the changed book, which the server turns into a patch for every client cache, and
  announces `StockChanged`.

## 4. Say who is calling

<<< @/../examples/typescript/src/resolvers.ts#auth{ts}

What this returns is `viewer` in the schema's `@allow` rules. The resolvers never check permissions themselves.

## 5. Start the server

`src/bookshop.ts` builds the server from the schema and the resolvers, then serves it at `/rayfold` with the explorer
beside it:

<<< @/../examples/typescript/src/bookshop.ts#server{ts}

`src/server.ts` starts it:

<<< @/../examples/typescript/src/server.ts{ts}

```sh
npx tsx src/server.ts
```

Open http://localhost:4000/rayfold/explorer to browse the operations and send requests. Type `customer` or `staff` in
the auth field to try the commands; the explorer adds the `Bearer` itself. Or call it with curl, marking the request
as a read with `rayfold-safe`:

```sh
curl -s localhost:4000/rayfold -H 'content-type: application/rayfold+json' -H 'rayfold-safe: true' \
  -d '{"rayfold":"0.1","ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ title stock author { name } }"}]}'
```

## 6. Call it from TypeScript

`src/client.ts`:

<<< @/../examples/typescript/src/client.ts#client{ts}

The shape asks for exactly the fields this code uses. Leave it out and the book's default fields come back.

A command's result updates the client cache, so anything watching that book sees the change without another
request:

<<< @/../examples/typescript/src/client.ts#watch{ts}

Errors the schema declares arrive typed:

<<< @/../examples/typescript/src/client.ts#errors{ts}

Run it while the server is up:

```sh
npx tsx src/client.ts
```

## Next

- Put a UI on it: [React](./react.md).
- How shapes, loaders and pages work: [Queries and shapes](../learn/queries.md).
- Everything the client does with a command's result: [Commands and errors](../learn/commands.md).
- The same requests, without installing anything: the [playground](../playground.md).
