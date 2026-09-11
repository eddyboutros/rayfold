/** Deterministic in-memory bookstore data. Reset with `seed()` between tests. */

export interface AuthorRow { id: string; name: string; bio: string | null }
export interface BookRow { id: string; title: string; format: "HARDCOVER" | "PAPERBACK" | "EBOOK"; price: string; stock: number; authorId: string; costPrice: string | null; ownerId: string }
export interface ReviewRow { id: string; rating: number; body: string; bookId: string; reviewerId: string; version: number }
export interface OrderRow { id: string; status: "PLACED" | "PAID" | "SHIPPED" | "CANCELLED"; customerId: string; items: Array<{ bookId: string; qty: number; unitPrice: string }>; total: string }

/**
 * The books table. Lists are served in id order, so the sorted id list is cached here and rebuilt only when an id is
 * added or removed. Replacing a row under its id (updateBook does) keeps the order, and readers look rows up by id,
 * so a replaced row is never served stale.
 */
export class BookTable extends Map<string, BookRow> {
  private sorted: string[] | undefined;
  /** How many times the id order was built. */
  sorts = 0;

  sortedIds(): readonly string[] {
    if (!this.sorted) {
      this.sorted = [...this.keys()].sort();
      this.sorts++;
    }
    return this.sorted;
  }
  override set(id: string, row: BookRow): this {
    if (!this.has(id)) this.sorted = undefined;
    return super.set(id, row);
  }
  override delete(id: string): boolean {
    if (this.has(id)) this.sorted = undefined;
    return super.delete(id);
  }
  override clear(): void {
    this.sorted = undefined;
    super.clear();
  }
}

export interface Store {
  authors: Map<string, AuthorRow>;
  books: BookTable;
  reviews: Map<string, ReviewRow>;
  orders: Map<string, OrderRow>;
  nextId: number;
  /** Count of loader invocations, for N+1 assertions. */
  calls: Record<string, number>;
}

export function seed(): Store {
  const authors = new Map<string, AuthorRow>([
    ["a1", { id: "a1", name: "Ursula K. Le Guin", bio: "American author of speculative fiction." }],
    ["a2", { id: "a2", name: "Italo Calvino", bio: null }],
    ["a3", { id: "a3", name: "Octavia E. Butler", bio: "Science fiction author from Pasadena." }],
  ]);
  const books = new BookTable([
    ["b1", { id: "b1", title: "The Dispossessed", format: "PAPERBACK", price: "12.99", stock: 5, authorId: "a1", costPrice: "6.10", ownerId: "u1" }],
    ["b2", { id: "b2", title: "Invisible Cities", format: "HARDCOVER", price: "19.50", stock: 2, authorId: "a2", costPrice: "9.00", ownerId: "u2" }],
    ["b3", { id: "b3", title: "Kindred", format: "EBOOK", price: "8.00", stock: 100, authorId: "a3", costPrice: "1.00", ownerId: "u1" }],
    ["b4", { id: "b4", title: "A Wizard of Earthsea", format: "PAPERBACK", price: "9.99", stock: 0, authorId: "a1", costPrice: "4.50", ownerId: "u1" }],
  ]);
  const reviews = new Map<string, ReviewRow>([
    ["r1", { id: "r1", rating: 5, body: "Ambiguous utopia, unambiguous masterpiece.", bookId: "b1", reviewerId: "u2", version: 1 }],
    ["r2", { id: "r2", rating: 4, body: "Dreamlike.", bookId: "b2", reviewerId: "u1", version: 1 }],
    ["r3", { id: "r3", rating: 5, body: "Devastating.", bookId: "b3", reviewerId: "u2", version: 1 }],
    ["r4", { id: "r4", rating: 3, body: "Slow start.", bookId: "b1", reviewerId: "u3", version: 1 }],
  ]);
  return { authors, books, reviews, orders: new Map(), nextId: 1, calls: {} };
}

export function count(store: Store, loader: string): void {
  store.calls[loader] = (store.calls[loader] ?? 0) + 1;
}

export function money(n: number): string {
  return n.toFixed(2);
}
