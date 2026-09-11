/**
 * A real catalogue for end-to-end runs and benchmarks: published books by their actual authors.
 * Prices, stock and formats are the store's own; reviews are store-customer reviews written for this demo.
 * Extends `seed()` (b1-b4, a1-a3, r1-r4) without touching those rows, so unit tests keep their fixtures.
 */
import type { AuthorRow, BookRow, ReviewRow, Store } from "./data.ts";

const AUTHORS: AuthorRow[] = [
  { id: "a4", name: "Toni Morrison", bio: "Nobel laureate in Literature, 1993." },
  { id: "a5", name: "Gabriel García Márquez", bio: "Nobel laureate in Literature, 1982." },
  { id: "a6", name: "Chimamanda Ngozi Adichie", bio: "Nigerian novelist and essayist." },
  { id: "a7", name: "Kazuo Ishiguro", bio: "Nobel laureate in Literature, 2017." },
  { id: "a8", name: "Jorge Luis Borges", bio: "Argentine writer of short stories, essays and poems." },
  { id: "a9", name: "Virginia Woolf", bio: "English modernist novelist and essayist." },
  { id: "a10", name: "Haruki Murakami", bio: null },
  { id: "a11", name: "N. K. Jemisin", bio: "Won the Hugo Award for Best Novel three years running for the Broken Earth trilogy." },
  { id: "a12", name: "Ted Chiang", bio: "Author of the novella Story of Your Life." },
];

type B = [id: string, title: string, authorId: string, format: BookRow["format"], price: string, stock: number, ownerId: string];
const BOOKS: B[] = [
  ["b5", "Beloved", "a4", "PAPERBACK", "9.50", 14, "u1"],
  ["b6", "Song of Solomon", "a4", "HARDCOVER", "24.00", 6, "u2"],
  ["b7", "One Hundred Years of Solitude", "a5", "PAPERBACK", "11.99", 20, "u1"],
  ["b8", "Love in the Time of Cholera", "a5", "EBOOK", "7.99", 1000, "u2"],
  ["b9", "Half of a Yellow Sun", "a6", "PAPERBACK", "10.00", 9, "u1"],
  ["b10", "Americanah", "a6", "HARDCOVER", "27.00", 4, "u2"],
  ["b11", "The Remains of the Day", "a7", "PAPERBACK", "8.99", 12, "u1"],
  ["b12", "Never Let Me Go", "a7", "EBOOK", "6.99", 1000, "u1"],
  ["b13", "Klara and the Sun", "a7", "HARDCOVER", "28.00", 7, "u2"],
  ["b14", "Ficciones", "a8", "PAPERBACK", "9.00", 5, "u1"],
  ["b15", "Labyrinths", "a8", "PAPERBACK", "13.00", 3, "u2"],
  ["b16", "Mrs Dalloway", "a9", "PAPERBACK", "7.50", 18, "u1"],
  ["b17", "To the Lighthouse", "a9", "HARDCOVER", "19.00", 2, "u2"],
  ["b18", "Orlando", "a9", "EBOOK", "4.99", 1000, "u1"],
  ["b19", "Kafka on the Shore", "a10", "PAPERBACK", "12.50", 8, "u2"],
  ["b20", "Norwegian Wood", "a10", "PAPERBACK", "10.99", 11, "u1"],
  ["b21", "The Fifth Season", "a11", "PAPERBACK", "9.99", 16, "u1"],
  ["b22", "The Obelisk Gate", "a11", "PAPERBACK", "9.99", 10, "u2"],
  ["b23", "The Stone Sky", "a11", "HARDCOVER", "26.00", 5, "u1"],
  ["b24", "Stories of Your Life and Others", "a12", "PAPERBACK", "11.00", 13, "u2"],
  ["b25", "Exhalation", "a12", "HARDCOVER", "25.00", 6, "u1"],
  ["b26", "The Left Hand of Darkness", "a1", "PAPERBACK", "10.49", 9, "u2"],
  ["b27", "The Lathe of Heaven", "a1", "EBOOK", "5.99", 1000, "u1"],
  ["b28", "If on a winter's night a traveler", "a2", "PAPERBACK", "12.00", 4, "u2"],
  ["b29", "Cosmicomics", "a2", "EBOOK", "6.49", 1000, "u1"],
  ["b30", "Parable of the Sower", "a3", "PAPERBACK", "9.25", 15, "u2"],
  ["b31", "Dawn", "a3", "PAPERBACK", "8.50", 7, "u1"],
  ["b32", "Sula", "a4", "EBOOK", "5.49", 1000, "u2"],
  ["b33", "Chronicle of a Death Foretold", "a5", "PAPERBACK", "8.00", 6, "u1"],
  ["b34", "Purple Hibiscus", "a6", "EBOOK", "6.99", 1000, "u2"],
  ["b35", "Hard-Boiled Wonderland and the End of the World", "a10", "HARDCOVER", "23.00", 3, "u1"],
  ["b36", "Tales from Earthsea", "a1", "HARDCOVER", "21.00", 2, "u2"],
];

type R = [id: string, bookId: string, rating: number, body: string, reviewerId: string];
const REVIEWS: R[] = [
  ["r5", "b5", 5, "Haunting from the first page to the last.", "u2"],
  ["r6", "b5", 4, "Demanding, and worth every hour.", "u3"],
  ["r7", "b7", 5, "The Buendia family tree on the inside cover saved me.", "u1"],
  ["r8", "b7", 3, "Beautiful sentences, too many Aurelianos.", "u4"],
  ["r9", "b9", 5, "Made a history I knew nothing about feel personal.", "u2"],
  ["r10", "b11", 5, "Quiet, precise and devastating.", "u3"],
  ["r11", "b12", 4, "I saw the twist coming and it still hurt.", "u1"],
  ["r12", "b14", 5, "Every story is a small labyrinth.", "u4"],
  ["r13", "b16", 4, "A whole life in a single June day.", "u2"],
  ["r14", "b19", 3, "Strange and dreamlike; I am still thinking about the cats.", "u5"],
  ["r15", "b21", 5, "The second-person chapters are brilliant.", "u1"],
  ["r16", "b21", 5, "Best worldbuilding I have read in years.", "u3"],
  ["r17", "b22", 4, "A middle book that earns its place.", "u2"],
  ["r18", "b24", 5, "Story of Your Life alone is worth the price.", "u4"],
  ["r19", "b25", 5, "The title story is a small perfect machine.", "u5"],
  ["r20", "b26", 4, "Still ahead of its time.", "u2"],
  ["r21", "b28", 4, "A novel about reading novels, and it works.", "u1"],
  ["r22", "b30", 5, "Uncomfortably prescient.", "u3"],
  ["r23", "b33", 4, "You know the ending on page one and read on anyway.", "u5"],
  ["r24", "b36", 4, "Good company for anyone who loved the first four books.", "u4"],
];

/** Adds the catalogue to a seeded store and returns it. */
export function withCatalogue(store: Store): Store {
  for (const a of AUTHORS) store.authors.set(a.id, { ...a });
  for (const [id, title, authorId, format, price, stock, ownerId] of BOOKS) {
    store.books.set(id, { id, title, authorId, format, price, stock, ownerId, costPrice: (Number(price) * 0.45).toFixed(2) });
  }
  for (const [id, bookId, rating, body, reviewerId] of REVIEWS) {
    const row: ReviewRow = { id, bookId, rating, body, reviewerId, version: 1 };
    store.reviews.set(id, row);
  }
  return store;
}

export const CATALOGUE_SIZE = { books: 4 + BOOKS.length, authors: 3 + AUTHORS.length, reviews: 4 + REVIEWS.length };
