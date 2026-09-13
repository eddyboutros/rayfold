import { describe, expect, it } from "vitest";
import { createBookstore } from "../../../examples/bookstore-ts/src/index.ts";
import { Capabilities, capabilityAllows } from "./capability.ts";

const SECRET = "a-secret-of-at-least-16-bytes";
const T0 = Date.parse("2026-09-13T00:00:00.000Z");
const at = (ms: number) => () => ms;

describe("capability tokens (spec 06 section 6)", () => {
  it("speaks for a viewer and names what its holder may call", () => {
    const caps = new Capabilities({ secret: SECRET, now: at(T0) });
    const token = caps.mint({ id: "u1", role: "customer" }, { ops: ["book", "books"], ttlMs: 60_000, iss: "checkout" });
    expect(caps.verify(token)).toMatchObject({ viewer: { id: "u1", role: "customer" }, ops: ["book", "books"], exp: T0 + 60_000, iss: "checkout" });
    expect(caps.viewerOf(token)).toMatchObject({ id: "u1", role: "customer", caps: { ops: ["book", "books"], exp: T0 + 60_000 } });
  });

  it("refuses one that was edited, one signed by someone else, one that expired, and anything else", () => {
    const caps = new Capabilities({ secret: SECRET, now: at(T0) });
    const token = caps.mint({ id: "u1" }, { ops: ["book"], ttlMs: 60_000 });
    const [prefix, payload, signature] = token.split(".");
    const edited = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as { ops: string[] };
    edited.ops = ["placeOrder"];
    const forged = `${prefix}.${Buffer.from(JSON.stringify(edited), "utf8").toString("base64url")}.${signature}`;
    expect(() => caps.verify(forged)).toThrow(/signature/);
    expect(() => new Capabilities({ secret: "a-different-secret-16!", now: at(T0) }).verify(token)).toThrow(/signature/);
    expect(() => new Capabilities({ secret: SECRET, now: at(T0 + 60_001) }).verify(token)).toThrow(/expired/);
    expect(() => caps.verify("nonsense")).toThrow(/Not a capability token/);
  });

  it("narrows on the way down and never widens", () => {
    const caps = new Capabilities({ secret: SECRET, now: at(T0) });
    const token = caps.mint({ id: "u1" }, { ops: ["book", "books", "author"], ttlMs: 600_000 });
    const narrower = caps.attenuate(token, { ops: ["book"], ttlMs: 30_000 });
    expect(caps.verify(narrower)).toMatchObject({ ops: ["book"], exp: T0 + 30_000 });
    // a derived token is a token in its own right, so it narrows again
    expect(caps.verify(caps.attenuate(narrower, { ops: [] })).ops).toEqual([]);
    // guard: it cannot gain an operation, and it cannot outlive what it came from
    expect(() => caps.attenuate(narrower, { ops: ["placeOrder"] })).toThrow(/widen/);
    expect(caps.verify(caps.attenuate(narrower, { ttlMs: 900_000 })).exp).toBe(T0 + 30_000);
  });

  it("the batch runs what the token names and refuses the rest", async () => {
    const caps = new Capabilities({ secret: SECRET, now: at(T0) });
    const bs = createBookstore();
    const viewer = caps.viewerOf(caps.mint({ id: "u1", role: "customer" }, { ops: ["book"], ttlMs: 60_000 }));

    const allowed = await bs.server.collect({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id title }" }] }, { viewer });
    expect(allowed[0]).toMatchObject({ id: 1, data: { id: "b1" } });

    const refused = await bs.server.collect({ ops: [{ id: 1, op: "author", args: { id: "a1" }, shape: "{ id }" }] }, { viewer });
    expect(refused[0]).toMatchObject({ id: 1, error: { code: "permission_denied" } });

    // guard: the same op for a viewer holding no capability still runs, so this narrows agents and not everyone
    const plain = await bs.server.collect({ ops: [{ id: 1, op: "author", args: { id: "a1" }, shape: "{ id }" }] }, { viewer: { id: "u1", role: "customer" } });
    expect(plain[0]).toMatchObject({ id: 1, data: { id: "a1" } });
  });

  it("leaves viewers that hold no capability alone", () => {
    expect(capabilityAllows(null, "book")).toBe(true);
    expect(capabilityAllows({ id: "u1" }, "book")).toBe(true);
    expect(capabilityAllows({ id: "u1", caps: { ops: ["books"] } }, "book")).toBe(false);
    expect(capabilityAllows({ id: "u1", caps: { ops: ["book"] } }, "book")).toBe(true);
  });
});
