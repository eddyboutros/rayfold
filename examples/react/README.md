# Bookshop in React

A React app on the bookshop server. The book list comes from `useQuery`, each stock count follows the server with
`useLive`, and the Buy button uses `useCommand`, so a purchase updates every place that shows that book without
fetching again.

- `src/App.tsx`: the components
- `src/main.tsx`: the client and the provider
- `src/server.ts` and `src/bookshop.ts`: the same bookshop server as in `examples/typescript`
- `vite.config.ts`: sends `/rayfold` from the Vite dev server to the Rayfold server

## Run it

Node.js 22 or later. From this folder:

```sh
npm install
npm run server
```

Then, in a second terminal:

```sh
npm run dev
```

Open http://localhost:5173. Open it in a second tab too, buy a book in one, and watch the stock change in the other.
