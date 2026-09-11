# Load results

Node v24.8.0, loopback HTTP/1.1, 64 concurrent clients for 10 s per workload on one machine (client and server share it), bookstore with the real catalogue slice. Memory is heap growth across the run after a forced collection.

| Workload | requests | per second | p50 ms | p99 ms | max ms | failed | heap growth MB |
|---|---:|---:|---:|---:|---:|---:|---:|
| read batch (product page) | 44162 | 4416 | 13.24 | 30.87 | 67.49 | 0 | 2.3 |
| command (placeOrder) | 44876 | 4488 | 13.51 | 24.34 | 40.84 | 0 | 72.3 |
| GET read (cacheable) | 68432 | 6843 | 8.16 | 18.25 | 26.89 | 0 | 1.5 |
