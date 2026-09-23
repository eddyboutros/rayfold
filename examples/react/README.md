# Bookshop in React

A React app on the bookshop server. The book list comes from `useQuery`, each stock count follows the server with
`useLive`, and the Buy button uses `useCommand`, so a purchase updates every place that shows that book without
fetching again.

- `src/App.tsx`: the components
- `src/main.tsx`: the client and the provider
- `src/bookshop.rayfold`: the schema, the same one every stack uses
- `src/resolvers.ts`: the data and the resolvers
- `src/auth.ts`: who the caller is, from the signed token (JWT) the client sends
- `src/session.ts`: the signed-in user's access token, where your identity provider's SDK goes
- `src/server.ts` and `src/bookshop.ts`: the same bookshop server as in `examples/typescript`
- `src/app.test.ts`: the components against a real server
- `vite.config.ts`: sends `/rayfold` from the Vite dev server to the Rayfold server

## Run it

Node.js 22 or later. From this folder:

```sh
npm install
npm run server
```

The page sends the signed-in user's access token with every request. Until sign-in is wired into `src/session.ts`, a
development token stands in, which the server accepts because it signed it. Print one into `.env.local`:

```sh
echo "VITE_DEV_TOKEN=$(npm run -s token)" > .env.local
```

Then, in a second terminal:

```sh
npm run dev
```

Open http://localhost:5173. Open it in a second tab too, buy a book in one, and watch the stock change in the other.
