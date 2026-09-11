import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRayfoldServer, type RayfoldServer, type RayfoldServerOptions } from "@rayfold/server";
import { seed, type Store } from "./data.ts";
import { bookstoreResolvers } from "./resolvers.ts";

export { seed, BookTable, type Store, type BookRow, type AuthorRow, type ReviewRow, type OrderRow } from "./data.ts";
export { bookPage, authorBookPages, type BookFilter, type Page, type PageArgs } from "./books.ts";
export { bookstoreResolvers } from "./resolvers.ts";
export { withCatalogue, CATALOGUE_SIZE } from "./catalogue.ts";
export { withGutenberg, gutenbergData, gutenbergBookId, gutenbergAuthorId, GUTENBERG_PATH, type GutenbergData } from "./gutenberg.ts";

export const BOOKSTORE_SCHEMA_PATH = fileURLToPath(new URL("../bookstore.rayfold", import.meta.url));
export const bookstoreSchemaText = (): string => readFileSync(BOOKSTORE_SCHEMA_PATH, "utf8");

export interface Bookstore {
  server: RayfoldServer;
  store: Store;
}

export function createBookstore(opts: Partial<Omit<RayfoldServerOptions, "schema" | "resolvers">> & { store?: Store } = {}): Bookstore {
  const store = opts.store ?? seed();
  const { store: _s, ...rest } = opts;
  const server = createRayfoldServer({ schema: bookstoreSchemaText(), resolvers: bookstoreResolvers(store), ...rest });
  return { server, store };
}
