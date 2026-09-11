# Real data

`gutenberg.json.gz` is the Project Gutenberg catalogue converted for Rayfold's real-data tests and web demo: every text in
the catalogue with its real title, primary author (with life dates where known), language and release date.

- Source: Project Gutenberg, https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv.gz (the catalogue feed that
  Project Gutenberg publishes for offline use; see https://www.gutenberg.org/ebooks/offline_catalogs.html).
- Rebuild: download the feed into `data/raw/`, then run `npx tsx scripts/import-gutenberg.ts`.
- Not in the catalogue, and therefore not real: prices, stock and reviews. The bookstore treats every book as a free
  ebook with unlimited stock and no reviews (see `examples/bookstore-ts/src/gutenberg.ts`).

Project Gutenberg is a registered trademark of the Project Gutenberg Literary Archive Foundation. Rayfold is not affiliated
with or endorsed by Project Gutenberg. Keep this attribution with the data when you publish it.

`raw/` holds the downloaded feed and can be deleted after the conversion.
