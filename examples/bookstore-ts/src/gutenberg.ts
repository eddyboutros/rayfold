/**
 * Real data: the Project Gutenberg catalogue (tens of thousands of real books by their real authors), loaded into the
 * bookstore store. Built by scripts/import-gutenberg.ts; see data/README.md for the source and terms.
 *
 * What is real: every title, author, author life dates, language and release date.
 * What the catalogue does not have: prices, stock and reviews. Project Gutenberg ebooks are free, so every book is an
 * EBOOK priced 0.00 with unlimited stock (1,000,000), published by the "gutenberg" account. There are no reviews.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import type { Store } from "./data.ts";

export const GUTENBERG_PATH = fileURLToPath(new URL("../../../data/gutenberg.json.gz", import.meta.url));

export interface GutenbergData {
  source: string;
  retrieved: string;
  note: string;
  authors: Array<[name: string, bio: string | null]>;
  books: Array<[textNo: number, title: string, author: number, language: string, issued: string]>;
}

let cached: GutenbergData | undefined;
/** The converted catalogue, parsed once per process. */
export function gutenbergData(): GutenbergData {
  cached ??= JSON.parse(gunzipSync(readFileSync(GUTENBERG_PATH)).toString("utf8")) as GutenbergData;
  return cached;
}

/** Ids: book `g<Text#>` (Text# is Project Gutenberg's own ebook number), author `ga<index>`. */
export const gutenbergBookId = (textNo: number) => `g${textNo}`;
export const gutenbergAuthorId = (index: number) => `ga${index}`;

/** Adds the catalogue (or its first `limit` books, by ebook number) to `store`, leaving existing rows alone. */
export function withGutenberg(store: Store, opts: { limit?: number } = {}): Store {
  const data = gutenbergData();
  const books = opts.limit === undefined ? data.books : data.books.slice(0, opts.limit);
  const used = new Set(books.map((b) => b[2]));
  for (const i of used) {
    const [name, bio] = data.authors[i]!;
    store.authors.set(gutenbergAuthorId(i), { id: gutenbergAuthorId(i), name, bio });
  }
  for (const [no, title, author] of books) {
    store.books.set(gutenbergBookId(no), { id: gutenbergBookId(no), title, format: "EBOOK", price: "0.00", stock: 1_000_000, authorId: gutenbergAuthorId(author), costPrice: null, ownerId: "gutenberg" });
  }
  return store;
}
