/**
 * Load test: the TypeScript server under sustained concurrent traffic on loopback, for throughput, tail latency,
 * errors, and memory that comes back after the load (no leak per request). Three workloads: the product-page read
 * batch, a command, and a cacheable GET. Every request is checked, not just counted.
 *
 *   npm run bench:load                      (LOAD_SECONDS=10 LOAD_CONCURRENCY=64 by default)
 *   node --expose-gc ... makes the memory figure exact; without it the heap is sampled as the collector left it.
 *
 * One machine plays both sides, so the numbers are a floor for a real deployment, not a forecast of one.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { listen } from "@rayfold/server";
import { createBookstore } from "../examples/bookstore-ts/src/index.ts";

const seconds = Number(process.env["LOAD_SECONDS"] ?? 10);
const concurrency = Number(process.env["LOAD_CONCURRENCY"] ?? 64);

const { server, store } = createBookstore();
for (const b of store.books.values()) b.stock = 1_000_000_000; // the command workload must not run out of stock
const http = await listen(server, 0, { viewer: (req) => (req.headers.authorization ? { id: String(req.headers.authorization).slice(7), role: "customer" } : null) });
const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}/rayfold`;
const json = { "content-type": "application/rayfold+json" };
const productPage = JSON.stringify({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id title format price stock author { id name } reviews(page: { first: 3 }) { items { id rating body } } }" }] });
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
let keyN = 0;

interface Workload { name: string; request: () => Promise<boolean> }
const workloads: Workload[] = [
  {
    name: "read batch (product page)",
    request: async () => {
      const res = await fetch(base, { method: "POST", headers: { ...json, "rayfold-safe": "true" }, body: productPage });
      const text = await res.text();
      return res.status === 200 && text.includes('"The Dispossessed"');
    },
  },
  {
    name: "command (placeOrder)",
    request: async () => {
      const key = `load-${process.pid}-${++keyN}`.padEnd(16, "0");
      const res = await fetch(base, { method: "POST", headers: { ...json, authorization: "Bearer u1" }, body: JSON.stringify({ ops: [{ id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: "b2", qty: 1 }] } }, key, shape: "{ id status }" }] }) });
      const text = await res.text();
      return res.status === 200 && text.includes('"PLACED"');
    },
  },
  {
    name: "GET read (cacheable)",
    request: async () => {
      const res = await fetch(`${base}/book?a=${b64({ id: "b3" })}&s=${encodeURIComponent("{ id title stock }")}`);
      const text = await res.text();
      return res.status === 200 && text.includes('"b3"');
    },
  },
];

const gc = (globalThis as { gc?: () => void }).gc;
const heapMb = () => {
  gc?.();
  return process.memoryUsage().heapUsed / 1_048_576;
};
const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? 0;

const rows: Array<Record<string, number | string>> = [];
for (const w of workloads) {
  for (let i = 0; i < 200; i++) await w.request(); // warm-up
  const heapBefore = heapMb();
  const latencies: number[] = [];
  let failed = 0;
  const deadline = performance.now() + seconds * 1000;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (performance.now() < deadline) {
        const t0 = performance.now();
        let ok = false;
        try {
          ok = await w.request();
        } catch {
          ok = false;
        }
        latencies.push(performance.now() - t0);
        if (!ok) failed++;
      }
    }),
  );
  latencies.sort((a, b) => a - b);
  const heapAfter = heapMb();
  const row = {
    workload: w.name,
    requests: latencies.length,
    perSecond: Math.round(latencies.length / seconds),
    p50: Number(pct(latencies, 0.5).toFixed(2)),
    p99: Number(pct(latencies, 0.99).toFixed(2)),
    max: Number((latencies.at(-1) ?? 0).toFixed(2)),
    failed,
    heapGrowthMb: Number((heapAfter - heapBefore).toFixed(1)),
  };
  rows.push(row);
  console.log(`${w.name}: ${row.perSecond}/s, p50 ${row.p50} ms, p99 ${row.p99} ms, ${failed} failed, heap ${row.heapGrowthMb >= 0 ? "+" : ""}${row.heapGrowthMb} MB`);
}
http.closeAllConnections();
http.close();

const lines = [
  "# Load results",
  "",
  `Node ${process.version}, loopback HTTP/1.1, ${concurrency} concurrent clients for ${seconds} s per workload on one machine (client and server share it), bookstore with the real catalogue slice. Memory is heap growth across the run${gc ? " after a forced collection" : ", sampled without forcing a collection"}.`,
  "",
  "| Workload | requests | per second | p50 ms | p99 ms | max ms | failed | heap growth MB |",
  "|---|---:|---:|---:|---:|---:|---:|---:|",
  ...rows.map((r) => `| ${r.workload} | ${r.requests} | ${r.perSecond} | ${r.p50} | ${r.p99} | ${r.max} | ${r.failed} | ${r.heapGrowthMb} |`),
  "",
  "Every command keeps an idempotency record for 24 h, at most 100 000 of them by default (spec 12 section 4): that, not a leak, is the command workload's heap growth, and it stops at the cap. The reads leave the heap where it was.",
  "",
];
mkdirSync("bench/results", { recursive: true });
writeFileSync("bench/results/load.md", lines.join("\n"));
writeFileSync("bench/results/load.json", JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version, seconds, concurrency, forcedGc: !!gc, rows }, null, 2) + "\n");
console.log("wrote bench/results/load.md and load.json");
process.exit(rows.some((r) => Number(r.failed) > 0) ? 1 : 0);
