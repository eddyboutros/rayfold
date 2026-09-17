---
title: React
description: A React app on a Rayfold server, with a live stock count and a Buy button.
---

<StackNav current="react" />

# Get started with React

A book list, stock counts that follow the server as they change, and a Buy button that handles a sold-out book. The
app talks to the bookshop server from any of the other guides on port 4000; the [TypeScript one](./typescript.md) is
the quickest to run beside it. The finished app is [examples/react](../../examples/react).

## 1. Create the app

```sh
npm create vite@latest bookshop-web -- --template react-ts
cd bookshop-web
npm install @rayfold/client @rayfold/react
```

## 2. Send API calls to the server

In development the page comes from Vite on port 5173 and the API from port 4000. Let Vite pass `/rayfold` on:

<<< @/../examples/react/vite.config.ts

The browser still names the page's origin on every command, and a Rayfold server refuses commands from origins it
does not know, which is what stops other websites from acting for your users. Behind the proxy above the request
arrives looking same-origin, so it is allowed whatever the server is written in; name the origin anyway, so the app
keeps working the day you point it straight at port 4000:

<<< @/../examples/react/src/bookshop.ts#origins{ts}

## 3. Provide the client

<<< @/../examples/react/src/main.tsx#provider{tsx}

The token stands in for your real sign-in. The server turns it into the viewer that the schema's `@allow` rules
check.

## 4. List the books

<<< @/../examples/react/src/App.tsx#list{tsx}

`useQuery` sends the query and keeps the result in the client cache. The shape names exactly the fields the list
shows, and the authors of the whole page are loaded in one call on the server.

## 5. Follow the stock

<<< @/../examples/react/src/App.tsx#live{tsx}

`useLive` keeps the query open. When anyone buys or restocks, the server sends a patch and only this component
renders again. Open the app in two tabs and buy in one of them to watch the other change.

## 6. Buy a copy

<<< @/../examples/react/src/App.tsx#buy{tsx}

`useCommand` gives each purchase its own idempotency key, so a retried request never buys twice. The book the
command returns updates the cache, and every component showing that book re-renders. `OutOfStock` is declared in
the schema, so the component checks for it by name.

## 7. Run it

With the server running on port 4000:

```sh
npm run dev
```

Open http://localhost:5173.

## Next

- More on `useQuery`, `useCommand`, `useLive` and server rendering: the [React guide](../guide/react.md).
- Show a purchase before the server answers, and queue it while offline: [Offline and optimistic](../guide/offline.md).
- How live queries work: [Live updates](../learn/live.md).
