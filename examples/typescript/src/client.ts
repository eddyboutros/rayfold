// #region client
// Run the server first (npm run server), then: npm run client
import { RayfoldClient, RayfoldClientError, createFetchTransport } from "@rayfold/client";
import { devToken } from "./auth.ts";

interface Book { id: string; title: string; stock: number; author: { name: string } }

// the access token the user's sign-in produced; a local run signs a customer's with the development key
const accessToken = process.env["TOKEN"] ?? (await devToken("u1", "customer"));

const client = new RayfoldClient({
  transport: createFetchTransport({
    url: "http://localhost:4000/rayfold",
    headers: () => ({ authorization: `Bearer ${accessToken}` }),
  }),
});

const book = await client.query<Book>("book", { id: "b1" }, { shape: "{ id title stock author { name } }" });
console.log(`${book.title} by ${book.author.name}: ${book.stock} in stock`);
// #endregion client

// #region watch
// The command returns the changed book, and the client cache applies it: no second request.
const stop = client.watch<Book>("book", { id: "b1" }, { shape: "{ id stock }" }, (b) => console.log("stock is now", b.stock));
await client.command("buy", { bookId: "b1", qty: 1 });
stop();
// #endregion watch

// #region live
// Stays open: every change anyone makes to this book arrives here, until stopLive() is called.
const stopLive = client.live<Book>("book", { id: "b3" }, { shape: "{ id stock }" }, (b, { initial }) => {
  console.log(initial ? `Dune starts at ${b.stock}` : `Dune is now at ${b.stock}`);
});
// #endregion live

// #region errors
try {
  await client.command("buy", { bookId: "b2" });
} catch (e) {
  if (!(e instanceof RayfoldClientError && e.is("OutOfStock"))) throw e;
  const { available } = e.data as { available: number };
  console.log(`Sold out: ${available} left`);
}
// #endregion errors

stopLive();
