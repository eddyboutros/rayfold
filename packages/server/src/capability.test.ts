import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { createBookstore } from "../../../examples/bookstore-ts/src/index.ts";
import { Capabilities, capabilityAllows } from "./capability.ts";

const SECRET = "a-secret-of-at-least-16-bytes";
const T0 = Date.parse("2026-09-13T00:00:00.000Z");
const at = (ms: number) => () => ms;

describe("capability tokens (spec 06 section 6)", () => {
  it("speaks for a viewer and names what its holder may call", () => {
    const caps = new Capabilities({ secret: SECRET, now: at(T0) });
    const token = caps.mint({ id: "u1", role: "customer" }, { ops: ["book", "books"], ttlMs: 60_000, iss: "checkout" });
    const jti = caps.verify(token).jti;
    expect(jti).toMatch(/^[0-9a-f]{32}$/);
    expect(caps.verify(token)).toEqual({ viewer: { id: "u1", role: "customer" }, ops: ["book", "books"], exp: T0 + 60_000, iss: "checkout", jti });
    expect(caps.viewerOf(token)).toEqual({ id: "u1", role: "customer", caps: { ops: ["book", "books"], exp: T0 + 60_000, jti, iss: "checkout" } });
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

  it("cannot add or change the facts policies read, only drop them", () => {
    const caps = new Capabilities({ secret: SECRET, now: at(T0) });
    const token = caps.mint({ id: "u1" }, { ops: ["book"], ttlMs: 600_000, caps: { tier: "basic", region: "eu" } });

    // dropping a fact is the narrowing attenuation is for
    expect(caps.verify(caps.attenuate(token, { caps: { tier: "basic" } })).caps).toEqual({ tier: "basic" });
    expect(caps.verify(caps.attenuate(token, { caps: {} })).caps).toEqual({});

    // guard: a holder must not be able to promote itself by restating a fact differently, or inventing a new one
    expect(() => caps.attenuate(token, { caps: { tier: "admin" } })).toThrow(/widen/);
    expect(() => caps.attenuate(token, { caps: { tier: "basic", plan: "unlimited" } })).toThrow(/widen/);
    expect(() => caps.attenuate(caps.mint({ id: "u1" }, { ops: [], ttlMs: 60_000 }), { caps: { tier: "admin" } })).toThrow(/widen/);
  });

  it("a fact named like the token's own metadata never stands in for it", () => {
    // `caps.ops` is the authorisation gate, so a fact called `ops` must not be able to shadow the signed one:
    // otherwise a holder mints itself the run of the schema through the facts side of the same token.
    const caps = new Capabilities({ secret: SECRET, now: at(T0) });
    const token = caps.mint({ id: "u1" }, { ops: ["book"], ttlMs: 60_000, caps: { ops: ["placeOrder"], exp: 0, jti: "forged" } });
    const viewer = caps.viewerOf(token) as { caps: { ops: string[]; exp: number; jti: string } };

    expect(viewer.caps.ops).toEqual(["book"]);
    expect(viewer.caps.exp).toBe(T0 + 60_000);
    expect(viewer.caps.jti).not.toBe("forged");
    expect(capabilityAllows(viewer, "placeOrder")).toBe(false);
    expect(capabilityAllows(viewer, "book")).toBe(true); // guard: the real grant still works
  });

  it("the batch runs what the token names and refuses the rest", async () => {
    const caps = new Capabilities({ secret: SECRET, now: at(T0) });
    const bs = createBookstore();
    const viewer = caps.viewerOf(caps.mint({ id: "u1", role: "customer" }, { ops: ["book"], ttlMs: 60_000 }));

    const allowed = await bs.server.collect({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id title }" }] }, { viewer });
    expect(allowed).toEqual([{ id: 1, data: { $type: "Book", id: "b1", title: "The Dispossessed" }, meta: { cost: 1 }, fin: true }]);

    const refused = await bs.server.collect({ ops: [{ id: 1, op: "author", args: { id: "a1" }, shape: "{ id }" }] }, { viewer });
    expect(refused).toEqual([{ id: 1, error: { code: "permission_denied", message: "This capability does not allow author()" }, fin: true }]);

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

describe("what a token must be, at each edge", () => {
  const caps = new Capabilities({ secret: SECRET, now: at(T0) });

  it("a secret shorter than 16 bytes is refused; one of exactly 16 is taken (guard)", () => {
    expect(() => new Capabilities({ secret: "x".repeat(15) })).toThrow("capability secret must be at least 16 bytes");
    expect(new Capabilities({ secret: "x".repeat(16), now: at(T0) }).verify(new Capabilities({ secret: "x".repeat(16), now: at(T0) }).mint(null, { ops: [], ttlMs: 1 })).exp).toBe(T0 + 1);
  });

  it("a life of nothing, or longer than the most allowed, is refused; the most allowed is taken (guard)", () => {
    expect(() => caps.mint(null, { ops: [], ttlMs: 0 })).toThrow("capability ttl must be between 1 and 3600000 ms");
    expect(() => caps.mint(null, { ops: [], ttlMs: 3_600_001 })).toThrow("capability ttl must be between 1 and 3600000 ms");
    expect(caps.verify(caps.mint(null, { ops: [], ttlMs: 3_600_000 })).exp).toBe(T0 + 3_600_000);
  });

  it("expires at exp exactly, not a millisecond later", () => {
    const token = caps.mint({ id: "u1" }, { ops: ["book"], ttlMs: 1_000 });
    expect(new Capabilities({ secret: SECRET, now: at(T0 + 999) }).verify(token).exp).toBe(T0 + 1_000);
    expect(() => new Capabilities({ secret: SECRET, now: at(T0 + 1_000) }).verify(token)).toThrow("Capability has expired");
  });

  it("its operations are kept sorted and once each", () => {
    expect(caps.verify(caps.mint(null, { ops: ["books", "book", "books"], ttlMs: 1_000 })).ops).toEqual(["book", "books"]);
  });

  it("a genuine payload and signature under another prefix is not a token", () => {
    const [, payload, signature] = caps.mint({ id: "u1" }, { ops: ["book"], ttlMs: 1_000 }).split(".");
    expect(() => caps.verify(`rfcap2.${payload}.${signature}`)).toThrow("Not a capability token");
  });

  it("a payload signed with the secret but shaped like no capability is refused", () => {
    const sign = (body: unknown) => {
      const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
      return `rfcap1.${payload}.${createHmac("sha256", SECRET).update(`rfcap1.${payload}`).digest("base64url")}`;
    };
    expect(() => caps.verify(sign({ viewer: null, exp: T0 + 1_000 }))).toThrow("Capability payload is not a capability");
    expect(() => caps.verify(sign({ viewer: null, ops: [], exp: "later" }))).toThrow("Capability payload is not a capability");
    expect(caps.verify(sign({ viewer: null, ops: [], exp: T0 + 1_000, jti: "j" })).ops).toEqual([]); // guard
  });

  it("cannot derive one that is already over", () => {
    const token = caps.mint(null, { ops: [], ttlMs: 1_000 });
    expect(() => caps.attenuate(token, { ttlMs: 0 })).toThrow("Cannot derive a capability that has expired");
  });

  it("a viewer that is no object is kept beside the facts rather than spread into them", () => {
    const token = caps.mint("service-7", { ops: ["book"], ttlMs: 1_000 });
    expect(caps.viewerOf(token)).toEqual({ viewer: "service-7", caps: { ops: ["book"], exp: T0 + 1_000, jti: caps.verify(token).jti } });
  });

  it("a viewer whose caps carry no list of operations holds no capability, and is left to the schema", () => {
    expect(capabilityAllows({ id: "u1", caps: { tier: "gold" } }, "book")).toBe(true);
    expect(capabilityAllows({ id: "u1", caps: { ops: "book" } }, "book")).toBe(true);
  });
});
