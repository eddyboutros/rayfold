import type { RayfoldClientError } from "@rayfold/client";
import { useCommand, useLive, useQuery } from "@rayfold/react";

interface Book {
  id: string;
  title: string;
  stock: number;
  author: { name: string };
}

export function App() {
  return (
    <main>
      <h1>Bookshop</h1>
      <BookList />
    </main>
  );
}

// #region list
function BookList() {
  const { data, error, loading } = useQuery<{ items: Book[] }>("books", { page: { first: 20 } }, { shape: "{ items { id title author { name } } }" });

  if (error) return <p role="alert">Could not load the books.</p>;
  if (loading && !data) return <p>Loading...</p>;
  return (
    <ul>
      {data?.items.map((book) => (
        <li key={book.id}>
          <strong>{book.title}</strong> by {book.author.name} <Stock id={book.id} /> <BuyButton id={book.id} />
        </li>
      ))}
    </ul>
  );
}
// #endregion list

// #region live
// Follows the stock as it changes, whoever buys or restocks.
function Stock({ id }: { id: string }) {
  const { data } = useLive<{ stock: number }>("book", { id }, { shape: "{ id stock }" });
  return <span data-stock={id}>{data ? `${data.stock} in stock` : "..."}</span>;
}
// #endregion live

// #region buy
function BuyButton({ id }: { id: string }) {
  const [buy, { running, error }] = useCommand<Book>("buy");
  const soldOut = (error as RayfoldClientError | undefined)?.is("OutOfStock");

  return (
    <>
      <button disabled={running} onClick={() => buy({ bookId: id })}>
        Buy
      </button>
      {soldOut && <span role="alert"> Sold out</span>}
    </>
  );
}
// #endregion buy
