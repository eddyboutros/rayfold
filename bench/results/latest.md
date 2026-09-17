# Bench results

Node v24.8.0 on win32/x64, loopback HTTP/1.1, 300 iterations per cell, interleaved, in-memory data (36 books by 12 authors). Latency includes client fetch overhead.

Run 2026-09-17T09:57:04.226Z. Regenerate with `npm run bench`.

## A. product page (book + author + 3 reviews)

| Implementation | round trips | bytes down | bytes up | p50 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| REST | 2 | 405 | 0 | 0.51 | 2.05 |
| GraphQL | 1 | 282 | 157 | 0.59 | 2.49 |
| Rayfold (JSON) | 1 | 302 | 182 | 0.60 | 2.10 |
| Rayfold (RB) | 1 | 177 | 143 | 0.62 | 2.44 |

## B. catalogue list (20 books with author names)

| Implementation | round trips | bytes down | bytes up | p50 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| REST | 2 | 2810 | 0 | 0.92 | 2.33 |
| GraphQL | 1 | 2074 | 89 | 0.54 | 4.51 |
| Rayfold (JSON) | 1 | 2083 | 142 | 0.53 | 1.59 |
| Rayfold (RB) | 1 | 1080 | 95 | 0.58 | 2.12 |

## C. place order then read it back with book stock

| Implementation | round trips | bytes down | bytes up | p50 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| REST | 3 | 327 | 35 | 0.52 | 4.47 |
| GraphQL | 2 | 157 | 204 | 0.86 | 3.44 |
| Rayfold (JSON) | 1 | 220 | 279 | 0.56 | 2.76 |
| Rayfold (RB) | 1 | 101 | 172 | 0.58 | 2.32 |

Notes:
- REST bytes exclude request bodies for GETs; round trips count dependent waves (parallel requests in one wave count once).
- GraphQL uses graphql-js with a DataLoader-style author batcher; bytes are the JSON response.
- Rayfold asks for compact frames, as its client does when it has the schema: no `$type` or `meta` (GraphQL's queries here ask for no __typename).
- Rayfold (RB) is the binary wire with the schema key dictionary; frames are identical to the JSON run.
- Each iteration runs every implementation once, rotating which goes first, so machine drift affects all alike.
