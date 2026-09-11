/**
 * Property-based fuzzing of what a client can send: arbitrary batch envelopes into the runtime, and arbitrary bytes
 * into the RB decoder and the HTTP transport. However malformed the input, the answer is frames or a problem
 * document, never an `internal` error and never a crash, and RB carries any JSON value unchanged. FUZZ_RUNS
 * (default 200) and FUZZ_SEED (default fixed) set the depth; the nightly workflow runs many more.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RbCodec } from "@rayfold/rb";
import { createBookstore } from "../../../examples/bookstore-ts/src/index.ts";
import { listen } from "./http.ts";
import type { Frame, RequestEnvelope } from "./protocol.ts";

const runs = Number(process.env["FUZZ_RUNS"] ?? 200);
const params = { numRuns: runs, seed: process.env["FUZZ_SEED"] ? Number(process.env["FUZZ_SEED"]) : 20260911 };

const { server } = createBookstore();
const ops = Object.keys(server.ir.ops);
const shapes = [undefined, "{ id }", "{ id title author { name } }", "{ items { id } total }", "{ nope }", "{ id @defer { title } }", "sha256:" + "0".repeat(64), "{"];
const viewers = [null, { id: "u1", role: "customer" }, { id: "u9", role: "admin" }];

const op = fc.record(
  {
    id: fc.oneof(fc.integer({ min: -2, max: 6 }), fc.string({ maxLength: 3 }), fc.constant(null)),
    op: fc.oneof(fc.constantFrom(...ops), fc.string({ maxLength: 8 })),
    args: fc.oneof(fc.jsonValue({ maxDepth: 3 }), fc.record({ id: fc.constantFrom("b1", "b2", "o1", "", 7), page: fc.jsonValue({ maxDepth: 2 }) }, { requiredKeys: [] })),
    shape: fc.constantFrom(...shapes),
    key: fc.oneof(fc.constant(undefined), fc.string({ minLength: 0, maxLength: 20 }), fc.constant("k".repeat(16))),
    live: fc.boolean(),
    compact: fc.boolean(),
    deadline: fc.oneof(fc.constant(undefined), fc.integer({ min: -5, max: 50 })),
  },
  { requiredKeys: ["id", "op"] },
);
const envelope = fc.oneof(
  fc.record({ ops: fc.array(op, { maxLength: 4 }), meta: fc.option(fc.jsonValue({ maxDepth: 2 }), { nil: undefined }) }, { requiredKeys: ["ops"] }),
  fc.jsonValue({ maxDepth: 3 }),
);

const internal = (frames: Frame[]) => frames.filter((f) => "error" in f && f.error.code === "internal");

describe("fuzzing what a client can send", () => {
  it("any envelope gets frames and never an internal error", async () => {
    await fc.assert(
      fc.asyncProperty(envelope, fc.constantFrom(...viewers), async (env, viewer) => {
        const ac = new AbortController();
        const frames: Frame[] = [];
        const done = (async () => {
          for await (const f of server.execute(env as RequestEnvelope, { viewer, signal: ac.signal })) {
            frames.push(f);
            // a live query stays open: its first frame is enough
            if ((env as RequestEnvelope | null)?.ops?.some?.((o) => o && typeof o === "object" && o.live)) ac.abort();
          }
        })();
        await done;
        expect(internal(frames), JSON.stringify(env)).toEqual([]);
      }),
      params,
    );
  });

  it("RB carries any JSON value unchanged, and any bytes decode or fail with the decoder's own error", () => {
    const codec = new RbCodec(server.ir);
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        expect(codec.decode(codec.encode(v))).toEqual(JSON.parse(JSON.stringify(v)));
      }),
      params,
    );
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        try {
          codec.decode(bytes);
        } catch (e) {
          if (!(e instanceof RangeError)) throw e;
        }
      }),
      params,
    );
  });

  describe("over HTTP", () => {
    let http: Server;
    let url: string;
    beforeAll(async () => {
      http = await listen(createBookstore().server, 0);
      url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/rayfold`;
    });
    afterAll(async () => {
      await new Promise<void>((r) => {
        http.close(() => r());
        http.closeAllConnections();
      });
    });

    it("any JSON or RB body gets frames or a problem document, never a 500", async () => {
      const codec = new RbCodec(server.ir);
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            envelope.map((e) => ({ type: "application/rayfold+json", body: JSON.stringify(e) as BodyInit })),
            fc.string({ maxLength: 200 }).map((s) => ({ type: "application/rayfold+json", body: s as BodyInit })),
            fc.uint8Array({ maxLength: 120 }).map((b) => ({ type: "application/rayfold", body: b as BodyInit })),
            envelope.map((e) => ({ type: "application/rayfold", body: codec.encode(e) as BodyInit })),
          ),
          async ({ type, body }) => {
            const ac = new AbortController();
            const res = await fetch(url, { method: "POST", headers: { "content-type": type, "rayfold-safe": "true" }, body, signal: ac.signal });
            expect(res.status, `${type} ${String(body)}`).toBeLessThan(500);
            ac.abort(); // a live query in the batch would keep the response open
          },
        ),
        { ...params, numRuns: Math.max(20, Math.floor(runs / 4)) },
      );
    });
  });
});
