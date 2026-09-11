import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { base64url, canonicalJson, fromBase64url, hashJson, sha256Hex, shapeIdOf } from "./index.ts";

// @rayfold/schema runs in browsers, so it hashes and encodes without node:crypto or Buffer. These tests hold the
// portable versions to what Node produces.

const nodeSha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

/** Deterministic pseudo-random numbers (LCG), so a failure reproduces. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000;
}

/** Random UTF-16 text mixing 1-, 2-, 3- and 4-byte UTF-8 characters, plus lone surrogates. */
function text(r: () => number, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    const k = r();
    if (k < 0.5) out += String.fromCharCode(32 + Math.floor(r() * 95));
    else if (k < 0.7) out += String.fromCharCode(0x80 + Math.floor(r() * 0x780));
    else if (k < 0.85) out += String.fromCharCode(0x800 + Math.floor(r() * 0xd000));
    else if (k < 0.95) out += String.fromCodePoint(0x10000 + Math.floor(r() * 0xfffff));
    else out += String.fromCharCode(0xd800 + Math.floor(r() * 0x800));
  }
  return out;
}

describe("sha256Hex without node:crypto", () => {
  it("matches node:crypto at every length through the first four 64-byte blocks", () => {
    for (let n = 0; n <= 260; n++) {
      const t = "x".repeat(n);
      expect(sha256Hex(t), `length ${n}`).toBe(nodeSha(t));
    }
  });

  it("matches node:crypto for multi-byte text and lone surrogates", () => {
    const r = rng(1);
    for (let i = 0; i < 300; i++) {
      const t = text(r, Math.floor(r() * 120));
      expect(sha256Hex(t)).toBe(nodeSha(t));
    }
  });

  it("matches node:crypto for a 1 MB input", () => {
    const t = text(rng(2), 1 << 20);
    expect(sha256Hex(t)).toBe(nodeSha(t));
  });

  it("is what schema hashes and shape ids are made of", () => {
    const v = { b: [1, "é", null], a: { z: true } };
    expect(hashJson(v)).toBe(nodeSha('{"a":{"z":true},"b":[1,"é",null]}'));
    expect(shapeIdOf("{ id title }")).toBe(`sha256:${nodeSha("{ id title }")}`);
  });

  it("guard: one changed character changes the hash", () => {
    expect(sha256Hex("{ id title }")).not.toBe(sha256Hex("{ id titlf }"));
    expect(hashJson({ a: 1 })).not.toBe(hashJson({ a: 2 }));
  });
});

describe("base64url without Buffer", () => {
  it("encodes like Buffer", () => {
    const r = rng(3);
    for (let i = 0; i < 500; i++) {
      const t = text(r, Math.floor(r() * 60));
      expect(base64url(t)).toBe(Buffer.from(t, "utf8").toString("base64url"));
    }
  });

  it("decodes anything the way Buffer does: padding, the standard alphabet, junk and malformed UTF-8", () => {
    const r = rng(4);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_+/= \n.$é{";
    for (let i = 0; i < 3000; i++) {
      let s = "";
      const n = Math.floor(r() * 40);
      for (let j = 0; j < n; j++) s += alphabet[Math.floor(r() * alphabet.length)];
      expect(fromBase64url(s), JSON.stringify(s)).toBe(Buffer.from(s, "base64url").toString("utf8"));
    }
  });

  it("round-trips well-formed text, including a JSON payload the server reads from a GET query", () => {
    const r = rng(5);
    for (let i = 0; i < 300; i++) {
      const t = text(r, Math.floor(r() * 80)).replace(/[\ud800-\udfff]/g, "?");
      expect(fromBase64url(base64url(t))).toBe(t);
    }
    const args = canonicalJson({ id: "b1", filter: { title: "Große Liebe" } });
    expect(JSON.parse(fromBase64url(base64url(args)))).toEqual({ id: "b1", filter: { title: "Große Liebe" } });
  });

  it("guard: a truncated payload does not decode to the original", () => {
    const b = base64url('{"id":"b1"}');
    expect(fromBase64url(b.slice(0, -2))).not.toBe('{"id":"b1"}');
  });
});
