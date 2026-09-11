/**
 * Book lists over the store, shared by everything that serves it: the Rayfold resolvers and the REST and GraphQL stacks in
 * e2e/harness.ts. One implementation keeps a comparison between them about the protocols, not about three scans.
 */
import type { BookRow, Store } from "./data.ts";

export interface PageArgs { first: number; after?: string | null; offset?: number | null }
export interface Page<T> { items: T[]; cursor: string | null; hasMore: boolean; total: number }
export interface BookFilter { titleContains?: string | null; format?: string | null; authorId?: string | null; maxPrice?: string | null }

export const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Where a page starts: just past the `after` cursor (an unknown cursor gives an empty page), else at `offset`. */
function startOf(total: number, p: PageArgs, indexOf: (id: string) => number): number {
  if (p.after) {
    const i = indexOf(p.after);
    return i < 0 ? total : i + 1;
  }
  return p.offset || 0;
}

function envelope<T extends { id: string }>(items: T[], start: number, p: PageArgs, total: number): Page<T> {
  return { items, cursor: items.length ? items[items.length - 1]!.id : null, hasMore: start + p.first < total, total };
}

/** A page of rows already in id order. */
export function page<T extends { id: string }>(rows: T[], p: PageArgs): Page<T> {
  const start = startOf(rows.length, p, (id) => rows.findIndex((r) => r.id === id));
  return envelope(rows.slice(start, start + p.first), start, p, rows.length);
}

function indexOfSorted(ids: readonly string[], id: string): number {
  let lo = 0;
  let hi = ids.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ids[mid]! < id) lo = mid + 1;
    else hi = mid;
  }
  return ids[lo] === id ? lo : -1;
}

/**
 * One page of books in id order. Without a filter only the page's rows are read, off the table's cached id order; with
 * one, the rows are scanned once and only the matches are sorted.
 */
export function bookPage(store: Store, filter: BookFilter | null | undefined, p: PageArgs): Page<BookRow> {
  const f = filter ?? {};
  if (!f.titleContains && !f.format && !f.authorId && !f.maxPrice) {
    const ids = store.books.sortedIds();
    const start = startOf(ids.length, p, (id) => indexOfSorted(ids, id));
    return envelope(ids.slice(start, start + p.first).map((id) => store.books.get(id)!), start, p, ids.length);
  }
  const needle = f.titleContains?.toLowerCase();
  const rows = [...store.books.values()].filter(
    (b) => (!needle || b.title.toLowerCase().includes(needle)) && (!f.format || b.format === f.format) && (!f.authorId || b.authorId === f.authorId) && (!f.maxPrice || Number(b.price) <= Number(f.maxPrice)),
  );
  return page(rows.sort(byId), p);
}

/** Each author's books in id order, paged. One scan of the table serves any number of authors, as a batch loader. */
export function authorBookPages(store: Store, authorIds: readonly string[], p: PageArgs): Array<Page<BookRow>> {
  const byAuthor = new Map<string, BookRow[]>(authorIds.map((id) => [id, []]));
  for (const b of store.books.values()) byAuthor.get(b.authorId)?.push(b);
  return authorIds.map((id) => page(byAuthor.get(id)!.sort(byId), p));
}
