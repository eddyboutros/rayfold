/**
 * The bookshop's data, resolvers and callers. Nothing here needs Node: the playground on the documentation site runs
 * this same file in the browser.
 */
import { RayfoldError, ok, type Resolvers } from "@rayfold/server/core";

export interface Author { id: string; name: string }
export interface Book { id: string; title: string; stock: number; authorId: string; costPrice: string }
export interface Viewer { id: string; role: "customer" | "staff" }

export function seed() {
  return {
    authors: new Map<string, Author>([
      ["a1", { id: "a1", name: "Ursula K. Le Guin" }],
      ["a2", { id: "a2", name: "Frank Herbert" }],
    ]),
    books: new Map<string, Book>([
      ["b1", { id: "b1", title: "A Wizard of Earthsea", stock: 3, authorId: "a1", costPrice: "4.20" }],
      ["b2", { id: "b2", title: "The Left Hand of Darkness", stock: 0, authorId: "a1", costPrice: "5.10" }],
      ["b3", { id: "b3", title: "Dune", stock: 7, authorId: "a2", costPrice: "6.00" }],
    ]),
  };
}
export type Store = ReturnType<typeof seed>;

// #region resolvers
export function resolvers(store: Store): Resolvers {
  const find = (id: string) => {
    const book = store.books.get(id);
    if (!book) throw new RayfoldError("not_found", `No book ${id}`);
    return book;
  };

  return {
    Query: {
      book: ({ id }: { id: string }) => store.books.get(id) ?? null,
      books: ({ page }: { page: { first: number; after?: string | null } }) => {
        const all = [...store.books.values()];
        const start = page.after ? all.findIndex((b) => b.id === page.after) + 1 : 0;
        const items = all.slice(start, start + page.first);
        return { items, total: all.length, hasMore: start + items.length < all.length, cursor: items.at(-1)?.id ?? null };
      },
    },

    Command: {
      // #region errors
      buy: ({ bookId, qty }: { bookId: string; qty: number }) => {
        const book = find(bookId);
        if (book.stock < qty) {
          throw RayfoldError.domain("OutOfStock", { bookId, available: book.stock }, `Only ${book.stock} left`);
        }
        book.stock -= qty;
        return ok(book, { emit: [{ event: "StockChanged", payload: { bookId, stock: book.stock } }] });
      },
      // #endregion errors
      restock: ({ bookId, qty }: { bookId: string; qty: number }) => {
        const book = find(bookId);
        book.stock += qty;
        return ok(book, { emit: [{ event: "StockChanged", payload: { bookId, stock: book.stock } }] });
      },
    },

    // #region loader
    // One call per level: a page of 20 books asks for their authors once, not 20 times.
    Book: {
      author: (books: Book[]) => books.map((b) => store.authors.get(b.authorId) ?? null),
    },
    // #endregion loader
  };
}
// #endregion resolvers

// #region auth
// Stands in for real authentication: check your session cookie or JWT here instead.
export function viewerFrom(authorization: string | undefined): Viewer | null {
  if (authorization === "Bearer customer") return { id: "u1", role: "customer" };
  if (authorization === "Bearer staff") return { id: "s1", role: "staff" };
  return null;
}
// #endregion auth
