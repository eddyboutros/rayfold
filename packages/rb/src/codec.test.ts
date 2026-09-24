import { describe, expect, it } from "vitest";
import { loadSchema } from "@rayfold/schema";
import { createBookstore, bookstoreSchemaText } from "../../../examples/bookstore-ts/src/index.ts";
import { KeyDictionary, RbCodec } from "./codec.ts";

const { ir } = loadSchema(bookstoreSchemaText());
const codec = new RbCodec(ir);
const plain = new RbCodec();

const samples: unknown[] = [
  null, true, false, 0, 1, 127, 128, -1, -128, 2 ** 40, -(2 ** 40), 1.5, -0.25, Number.MAX_SAFE_INTEGER, "", "a", "héllo wörld ✓", "x".repeat(300),
  [], [1, [2, [3]]], {}, { a: 1 }, { $type: "Book", id: "b1", title: "T", nested: { $ref: "Author:a1" } },
  { id: 1, data: { items: [{ $type: "Book", id: "b1" }, { $type: "Book", id: "b2" }] }, meta: { cost: 9 }, fin: true },
  { id: 1, error: { code: "domain", type: "OutOfStock", message: "no", data: { bookId: "b4", available: 0 } }, fin: true },
  { weird_key_not_in_dict: [true, null, "s", { "another odd key": 2 }] },
];

describe("RB codec", () => {
  it("round-trips every sample with and without a schema dictionary", () => {
    for (const s of samples) {
      expect(codec.decode(codec.encode(s))).toEqual(s);
      expect(plain.decode(plain.encode(s))).toEqual(s);
    }
  });

  it("encodes NaN, the infinities and a Date as JSON sends them; guard: finite doubles and bytes are unchanged", () => {
    const v = { nan: Number.NaN, inf: Infinity, ninf: -Infinity, when: new Date(0), list: [Number.NaN, new Date(1000)], half: 2.5, b: new Uint8Array([1, 2]) };
    for (const c of [codec, plain]) {
      expect(c.decode(c.encode(v))).toEqual({ nan: null, inf: null, ninf: null, when: "1970-01-01T00:00:00.000Z", list: [null, "1970-01-01T00:00:01.000Z"], half: 2.5, b: new Uint8Array([1, 2]) });
    }
    expect([...plain.encode(Number.NaN)]).toEqual([0x00]);
    expect([...plain.encode(2.5)]).toEqual([0x04, 0, 0, 0, 0, 0, 0, 0x04, 0x40]);
  });

  it("round-trips bytes and drops undefined object members like JSON", () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    expect(codec.decode(codec.encode({ b: bytes }))).toEqual({ b: bytes });
    expect(codec.decode(codec.encode({ a: 1, u: undefined }))).toEqual({ a: 1 });
  });

  it("random structures round-trip (property test)", () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const gen = (depth: number): unknown => {
      const r = rnd();
      if (depth > 4 || r < 0.15) return Math.floor(rnd() * 2000) - 1000;
      if (r < 0.3) return rnd() * 1e6 - 5e5;
      if (r < 0.45) return ["id", "title", "Book", "x".repeat(Math.floor(rnd() * 20)), "unicode ✓ 日本"][Math.floor(rnd() * 5)];
      if (r < 0.55) return rnd() < 0.5;
      if (r < 0.6) return null;
      if (r < 0.8) return Array.from({ length: Math.floor(rnd() * 5) }, () => gen(depth + 1));
      const o: Record<string, unknown> = {};
      for (let i = 0; i < Math.floor(rnd() * 5); i++) o[["id", "title", "stock", "author", "k" + i][Math.floor(rnd() * 5)]!] = gen(depth + 1);
      return o;
    };
    for (let i = 0; i < 300; i++) {
      const v = gen(0);
      expect(codec.decode(codec.encode(v))).toEqual(v);
    }
  });

  it("frames are length-prefixed and decode incrementally across chunk boundaries", () => {
    const frames = samples.slice(-4);
    const bytes = codec.encodeFrames(frames);
    expect(codec.decodeFrames(bytes)).toEqual(frames);
    const d = codec.decoder();
    const out: unknown[] = [];
    for (let i = 0; i < bytes.length; i += 7) out.push(...d.feed(bytes.subarray(i, Math.min(i + 7, bytes.length))));
    expect(out).toEqual(frames);
    expect(d.pendingBytes).toBe(0);
    expect(() => codec.decodeFrames(bytes.subarray(0, bytes.length - 1))).toThrow(/truncated/);
  });

  it("the key dictionary is deterministic from the IR and reserves frame keys", () => {
    const a = new KeyDictionary(ir);
    const b = new KeyDictionary(loadSchema(bookstoreSchemaText()).ir);
    expect(a.names).toEqual(b.names);
    expect(a.ids.get("id")).toBe(0);
    expect(a.ids.get("costPrice")).toBe(59);
  });

  it("is materially smaller than JSON on a realistic response", async () => {
    const { server } = createBookstore();
    const frames = await server.collect({ ops: [{ id: 1, op: "books", args: { page: { first: 4 } }, shape: "{ items { id title format price stock author { id name } reviews(page: { first: 3 }) { items { id rating body } } } hasMore cursor total }" }] });
    const json = Buffer.byteLength(frames.map((f) => JSON.stringify(f)).join("\n"));
    const rb = codec.encodeFrames(frames).length;
    expect(codec.decodeFrames(codec.encodeFrames(frames))).toEqual(frames);
    expect(rb).toBeLessThan(json * 0.6);
  });
});

// ------------------------------------------------------------------ security (spec 12)
import { RbCodec as SecCodec } from "./codec.ts";

describe("security: decoding hostile RB", () => {
  const codec = new SecCodec();

  it("a \"__proto__\" key decodes as an own property, never as a new prototype", () => {
    const decoded = codec.decode(codec.encode(JSON.parse('{"__proto__":{"polluted":true},"a":1}'))) as Record<string, unknown>;
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(Object.keys(decoded)).toEqual(["__proto__", "a"]);
    expect(decoded["polluted"]).toBeUndefined();
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("values nested deeper than 64 levels are refused; 60 levels round-trip (guard)", () => {
    const nest = (n: number): unknown => (n === 0 ? 1 : [nest(n - 1)]);
    expect(() => codec.decode(codec.encode(nest(100)))).toThrow(/nested deeper than 64 levels/);
    expect(codec.decode(codec.encode(nest(60)))).toEqual(nest(60));
  });

  it("a list that claims more elements than the bytes left is refused before allocating", () => {
    const bytes = codec.encode([1, 2, 3]);
    const forged = Uint8Array.from(bytes);
    forged[1] = 0x7f; // element count 127, with three elements' worth of bytes behind it
    expect(() => codec.decode(forged)).toThrow(/length exceeds the input|unexpected end/);
  });

  // each forged input sits next to the nearest valid one, so a check that refused everything would fail too
  it.each([
    ["an overlong varint", [0x03, ...Array(9).fill(0xff)], /^RB: varint too long$/, [0x03, ...Array(8).fill(0x80), 0x00], 0],
    ["an unknown key id", [0x08, 0x01, 40 * 2, 0x00], /^RB: unknown key id 40$/, [0x08, 0x01, 39 * 2, 0x00], { ins: null }],
    ["a string reference past the table", [0x07, 0x02, 0x05, 0x01, 0x61, 0x06, 0x01], /^RB: bad string reference$/, [0x07, 0x02, 0x05, 0x01, 0x61, 0x06, 0x00], ["a", "a"]],
    ["an unknown tag", [0x0a], /^RB: unknown tag 0xa$/, [0x09, 0x00], new Uint8Array(0)],
    ["trailing bytes", [0x00, 0x00], /^RB: trailing bytes$/, [0x00], null],
  ])("%s is refused with an exact error", (_name, bad, message, good, value) => {
    expect(() => codec.decode(Uint8Array.from(bad as number[]))).toThrow(message);
    expect(codec.decode(Uint8Array.from(good as number[]))).toEqual(value);
  });
});

describe("RB integers near 2^53", () => {
  it("keep their sign and value: the zigzag value is written and read exactly above 2^52", () => {
    for (const v of [2 ** 52, 2 ** 52 + 1, -(2 ** 52) - 1, -(2 ** 53) + 3, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]) {
      expect(codec.decode(codec.encode(v))).toBe(v);
    }
    // zigzag of -(2^53 - 1) is 2^54 - 3; double arithmetic used to write 2^54 - 4, which decoded as +(2^53 - 2)
    expect(Buffer.from(codec.encode(-Number.MAX_SAFE_INTEGER)).toString("hex")).toBe("03fdffffffffffff1f");
  });
});
