# Bench results

Node v24.8.0, loopback HTTP/1.1, 300 iterations per cell, interleaved, in-memory data (40 books). Latency includes client fetch overhead.

## A. product page (book + author + 3 reviews)

| Implementation | round trips | bytes down | bytes up | p50 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| REST | 2 | 405 | 0 | 0.44 | 1.71 |
| GraphQL | 1 | 282 | 157 | 0.48 | 1.97 |
| Rayfold (JSON) | 1 | 302 | 182 | 0.41 | 1.03 |
| Rayfold (RB) | 1 | 176 | 143 | 0.43 | 1.88 |

## B. catalogue list (20 books with author names)

| Implementation | round trips | bytes down | bytes up | p50 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| REST | 2 | 2810 | 0 | 0.83 | 4.34 |
| GraphQL | 1 | 2074 | 89 | 0.48 | 3.29 |
| Rayfold (JSON) | 1 | 2083 | 142 | 0.38 | 0.92 |
| Rayfold (RB) | 1 | 1080 | 94 | 0.44 | 1.05 |

## C. place order then read it back with book stock

| Implementation | round trips | bytes down | bytes up | p50 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| REST | 3 | 327 | 35 | 0.47 | 3.44 |
| GraphQL | 2 | 157 | 204 | 0.72 | 3.80 |
| Rayfold (JSON) | 1 | 220 | 279 | 0.40 | 1.01 |
| Rayfold (RB) | 1 | 101 | 172 | 0.42 | 0.82 |

Notes:
- REST bytes exclude request bodies for GETs; round trips count dependent waves (parallel requests in one wave count once).
- GraphQL uses graphql-js with a DataLoader-style author batcher; bytes are the JSON response.
- Rayfold asks for compact frames, as its client does when it has the schema: no `$type` or `meta` (GraphQL's queries here ask for no __typename).
- Rayfold (RB) is the binary wire with the schema key dictionary; frames are identical to the JSON run.
- Each iteration runs every implementation once, rotating which goes first, so machine drift affects all alike.
