/**
 * Two security invariants, stated as properties rather than examples, because both were broken by code that passed
 * a suite full of examples. An example proves a case; a property proves the rule, and these are rules a reviewer
 * should be able to read off the test names.
 *
 *   1. Delegation never gains authority: authority(child) is a subset of authority(parent), for every derivation.
 *   2. A read is a read: no path MCP exposes as a resource dispatches a command.
 *
 * FUZZ_RUNS (default 200) and FUZZ_SEED set the depth, as in fuzz.test.ts.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createBookstore } from "../../../examples/bookstore-ts/src/index.ts";
import { Capabilities, capabilityAllows } from "./capability.ts";
import { handleMcp, mcpResources } from "./mcp.ts";

const runs = Number(process.env["FUZZ_RUNS"] ?? 200);
const params = { numRuns: runs, seed: process.env["FUZZ_SEED"] ? Number(process.env["FUZZ_SEED"]) : 20260917 };

const SECRET = "a-secret-of-at-least-16-bytes";
const T0 = Date.parse("2026-09-17T00:00:00.000Z");

/** Op names a token might name, some real and some not, so narrowing is exercised against both. */
const OPS = ["book", "books", "author", "myOrders", "placeOrder", "restock", "nope"];
/** Fact values that are cheap to confuse: same shape, different content, and different orderings of one object. */
const FACT_VALUES = [1, 2, "basic", "admin", true, false, null, { a: 1 }, { a: 2 }, { a: 1, b: 2 }, { b: 2, a: 1 }, [1, 2], [2, 1]];

const facts = fc.dictionary(fc.constantFrom("tier", "region", "plan", "ops", "exp", "jti", "iss"), fc.constantFrom(...FACT_VALUES), { maxKeys: 4 });

/**
 * The token's own fields, which are not facts a holder carries: `jti` is deliberately new for each derivation, and
 * `exp` may shrink, which is narrowing. They are compared by their own rules below rather than as authority.
 */
const METADATA = new Set(["ops", "exp", "jti", "iss"]);

/** What a token actually lets its holder do: the operations it passes, and the facts policies can read off it. */
function authority(caps: Capabilities, token: string): { ops: Set<string>; facts: Map<string, string>; exp: number } {
  const viewer = caps.viewerOf(token) as { caps: Record<string, unknown> & { exp: number } };
  const allowed = new Set(OPS.filter((op) => capabilityAllows(viewer, op)));
  const seen = new Map<string, string>();
  for (const [k, v] of Object.entries(viewer.caps)) if (!METADATA.has(k)) seen.set(k, JSON.stringify(v));
  return { ops: allowed, facts: seen, exp: viewer.caps.exp };
}

describe("delegation never gains authority (spec 06 section 6)", () => {
  it("a derived token allows no operation its parent refused, however it was narrowed", () => {
    const caps = new Capabilities({ secret: SECRET, now: () => T0 });
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...OPS), { maxLength: 5 }),
        facts,
        fc.option(fc.uniqueArray(fc.constantFrom(...OPS), { maxLength: 5 }), { nil: undefined }),
        fc.option(facts, { nil: undefined }),
        (parentOps, parentFacts, narrowOps, narrowFacts) => {
          const parent = caps.mint({ id: "u1" }, { ops: parentOps, ttlMs: 600_000, caps: parentFacts });
          let child: string;
          try {
            child = caps.attenuate(parent, { ...(narrowOps ? { ops: narrowOps } : {}), ...(narrowFacts ? { caps: narrowFacts } : {}) });
          } catch {
            return true; // a refusal is always a safe answer; the property is about what a derivation that succeeds may do
          }
          const before = authority(caps, parent);
          const after = authority(caps, child);
          for (const op of after.ops) expect(before.ops.has(op), `${op} was gained by attenuating`).toBe(true);
          // a fact the parent did not carry, or carried differently, is authority too: policies read viewer.caps.*
          for (const [k, v] of after.facts) expect(before.facts.get(k), `caps.${k} was gained by attenuating`).toBe(v);
          expect(after.exp, "a derived token outlived the one it came from").toBeLessThanOrEqual(before.exp);
          return true;
        },
      ),
      params,
    );
  });

  it("a chain of derivations only ever loses, and the guard is that narrowing itself still works", () => {
    const caps = new Capabilities({ secret: SECRET, now: () => T0 });
    const root = caps.mint({ id: "u1" }, { ops: ["book", "books", "author"], ttlMs: 600_000, caps: { tier: "basic", region: "eu" } });
    let token = root;
    for (const step of [["book", "books"], ["book"], []] as string[][]) {
      token = caps.attenuate(token, { ops: step });
      expect([...authority(caps, token).ops]).toEqual(step);
    }
    // guard: the property above would also hold if attenuation simply refused everything
    expect([...authority(caps, caps.attenuate(root, { ops: ["book"] })).ops]).toEqual(["book"]);
    expect(authority(caps, caps.attenuate(root, { caps: { tier: "basic" } })).facts.has("region")).toBe(false);
  });
});

describe("a resource read never writes (spec 10 section 3)", () => {
  it("no resource URI dispatches a command, whatever it names", async () => {
    const bs = createBookstore();
    const commands = Object.values(bs.server.ir.ops).filter((o) => o.kind === "command").map((o) => o.name);
    expect(commands.length).toBeGreaterThan(0); // or this proves nothing
    const stockBefore = bs.store.books.get("b1")!.stock; // observed, not assumed: the seed is free to change

    // Arguments that really would satisfy each command, so "nothing ran" is not just argument coercion failing:
    // restock(bookId, qty) coerces straight from a query string, and this viewer passes its write policy.
    const ARMED = ["rayfold://query/restock?bookId=b1&qty=1", "rayfold://query/restock.simulate?bookId=b1&qty=1"];
    const uris = fc.oneof(
      fc.constantFrom(...commands).map((name) => `rayfold://query/${name}`),
      fc.constantFrom(...commands).map((name) => `rayfold://query/${name}?bookId=b1&qty=1`),
      fc.constantFrom(...ARMED),
      fc.constantFrom(...mcpResources(bs.server).map((r) => r.uri)),
      fc.string({ maxLength: 40 }).map((s) => `rayfold://query/${s}`),
      fc.string({ maxLength: 40 }),
    );
    const isQuery = (uri: string): boolean => {
      const m = /^rayfold:\/\/query\/([A-Za-z_][A-Za-z0-9_]*)/.exec(uri);
      return !!m && bs.server.ir.ops[m[1]!]?.kind === "query";
    };

    await fc.assert(
      fc.asyncProperty(uris, async (uri) => {
        const before = commands.reduce((n, c) => n + (bs.store.calls[`Command.${c}`] ?? 0), 0);
        const reply = (await handleMcp(bs.server, { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri } }, { id: "u1", role: "admin" })) as { error?: { code: number } };
        // the operation's kind decides: anything that is not a query is refused as a resource rather than attempted,
        // so a command cannot be reached here even by a caller who would be allowed to run it as a tool
        if (!isQuery(uri) && uri !== "rayfold://schema") expect(reply.error?.code, `${uri} was not refused`).toBe(-32602);
        const after = commands.reduce((n, c) => n + (bs.store.calls[`Command.${c}`] ?? 0), 0);
        expect(after, `${uri} dispatched a command`).toBe(before);
      }),
      params,
    );
    expect(bs.store.orders.size).toBe(0); // nothing was written by any of it
    expect(bs.store.books.get("b1")!.stock).toBe(stockBefore); // and the armed restock left the shelf alone

    // guard: the same pipeline does run a command when it is asked to as a tool, so the check above is not vacuous
    await handleMcp(bs.server, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "placeOrder", arguments: { input: { lines: [{ bookId: "b1", qty: 1 }] } } } }, { id: "u1", role: "customer" });
    expect(bs.store.orders.size).toBe(1);
  });
});
