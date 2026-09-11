/**
 * Converts the Project Gutenberg catalogue into data/gutenberg.json.gz, the real data behind e2e/realdata.test.ts
 * and the web demo. Source: https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv.gz (catalogue metadata,
 * free to use; see data/README.md). Every book, title, author, language and release date is real.
 *
 *   curl -L -o data/raw/pg_catalog.csv.gz https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv.gz
 *   npx tsx scripts/import-gutenberg.ts [data/raw/pg_catalog.csv.gz]
 */
import { gunzipSync, gzipSync } from "node:zlib";
import { readFileSync, statSync, writeFileSync } from "node:fs";

const input = process.argv[2] ?? "data/raw/pg_catalog.csv.gz";
const text = gunzipSync(readFileSync(input)).toString("utf8");

/** RFC 4180: quoted fields may hold commas, quotes ("") and line breaks. */
function parseCsv(src: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const [header, ...records] = parseCsv(text);
const col = (name: string) => {
  const i = header!.indexOf(name);
  if (i < 0) throw new Error(`catalogue has no column ${name}`);
  return i;
};
const cNo = col("Text#"), cType = col("Type"), cIssued = col("Issued"), cTitle = col("Title"), cLang = col("Language"), cAuthors = col("Authors");

const LIFE = /^(\d{1,4}\??( BCE?)?)?(-(\d{1,4}\??( BCE?)?)?)?$/;
/** "Twain, Mark, 1835-1910 [Illustrator]" -> { key, name: "Mark Twain", bio: "Lived 1835-1910." } */
function parseAuthor(raw: string): { key: string; name: string; bio: string | null } {
  const noRole = raw.replace(/\s*\[[^\]]*\]\s*$/, "").trim();
  const parts = noRole.split(",").map((p) => p.trim()).filter(Boolean);
  let dates: string | null = null;
  if (parts.length > 1 && LIFE.test(parts[parts.length - 1]!) && /\d/.test(parts[parts.length - 1]!)) dates = parts.pop()!;
  const [last, first, ...rest] = parts;
  const given = first ? first.replace(/\s*\([^)]*\)/g, "").trim() : "";
  // Titles after the given name stay after a comma, as the catalogue writes them: "Edward Bulwer Lytton Lytton, Baron".
  const name = ([given, last].filter(Boolean).join(" ") + (rest.length ? `, ${rest.join(", ")}` : "")) || noRole || "Unknown";
  const bio = dates ? (dates.startsWith("-") ? `Died ${dates.slice(1)}.` : dates.endsWith("-") ? `Born ${dates.slice(0, -1)}.` : dates.includes("-") ? `Lived ${dates}.` : `Active ${dates}.`) : null;
  return { key: noRole, name, bio };
}

const authorIndex = new Map<string, number>();
const authors: Array<[name: string, bio: string | null]> = [["Unknown author", null]];
authorIndex.set("", 0);
const books: Array<[textNo: number, title: string, author: number, language: string, issued: string]> = [];
for (const r of records) {
  if (r.length < header!.length || r[cType] !== "Text") continue;
  const no = Number(r[cNo]);
  if (!Number.isInteger(no)) continue;
  const primary = (r[cAuthors] ?? "").split(/;\s*/).map((a) => a.trim()).filter(Boolean);
  const main = primary.find((a) => !/\[[^\]]*\]$/.test(a) || /\[Author\]$/.test(a)) ?? primary[0] ?? "";
  const a = main ? parseAuthor(main) : { key: "", name: "Unknown author", bio: null };
  let idx = authorIndex.get(a.key);
  if (idx === undefined) {
    idx = authors.length;
    authorIndex.set(a.key, idx);
    authors.push([a.name, a.bio]);
  }
  const title = (r[cTitle] ?? "").replace(/\s*\r?\n\s*/g, ": ").replace(/\s+/g, " ").trim();
  if (!title) continue;
  books.push([no, title, idx, r[cLang] ?? "", r[cIssued] ?? ""]);
}
books.sort((x, y) => x[0] - y[0]);

const out = {
  source: "Project Gutenberg catalogue, https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv.gz",
  retrieved: new Date(statSync(input).mtime).toISOString().slice(0, 10),
  note: "Titles, authors, author life dates, languages and release dates are Project Gutenberg's. Prices, stock and reviews are not part of the catalogue.",
  authors,
  books,
};
writeFileSync("data/gutenberg.json.gz", gzipSync(Buffer.from(JSON.stringify(out)), { level: 9 }));
console.log(`wrote data/gutenberg.json.gz: ${books.length} books by ${authors.length} authors (${statSync("data/gutenberg.json.gz").size} bytes)`);
