# Load results

Node v24.8.0 on win32/x64, loopback HTTP/1.1, 64 concurrent clients for 10 s per workload on one machine (client and server share it), bookstore with the real catalogue slice. Memory is heap growth across the run after a forced collection.

Run 2026-09-17T10:02:31.032Z. Regenerate with `npm run bench:load`.

| Workload | requests | per second | p50 ms | p99 ms | max ms | failed | heap growth MB |
|---|---:|---:|---:|---:|---:|---:|---:|
| read batch (product page) | 16985 | 1699 | 34.91 | 72.13 | 82.71 | 0 | 2 |
| command (placeOrder) | 14759 | 1476 | 42.01 | 75.41 | 111.68 | 0 | 24.9 |
| GET read (cacheable) | 22802 | 2280 | 25.63 | 57.29 | 79.71 | 0 | 1.5 |

Every command keeps an idempotency record for 24 h, at most 100 000 of them by default (spec 12 section 4): that, not a leak, is the command workload's heap growth, and it stops at the cap. The reads leave the heap where it was.
