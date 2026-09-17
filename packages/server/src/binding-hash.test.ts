import { canonicalJson, hashJson } from "@rayfold/schema";
import { describe, expect, it } from "vitest";

/**
 * The two hashes a shared idempotency store makes cross-runtime (spec 12 §4): the scope a record is kept under and the
 * binding it carries. The vectors here are the same ones `CanonicalHashTest.kt` asserts on the JVM, so that a change to
 * either runtime's canonicaliser fails a test instead of quietly stopping one fleet's servers from replaying for each
 * other. The numbers are the ones the two spell differently if nobody pins them.
 */
const BINDING = "c3a798f6ee29dd08612660fc7b227a6cdc93efc9df9fb30638e91718931c01d2";
const VIEWER = "e779509076f090fa2c72f7c489668c5723811a96cdfeacc9ea1e8c3f949e3d5e";

describe("the hash a record is bound by", () => {
  it("is the SHA-256 of the canonical JSON of the operation and its arguments", () => {
    expect(canonicalJson({ op: "restock", args: { id: "b1", qty: 2.5 } })).toBe('{"args":{"id":"b1","qty":2.5},"op":"restock"}');
    expect(hashJson({ op: "restock", args: { id: "b1", qty: 2.5 } })).toBe(BINDING);
    // the arguments written in another order are the same binding: canonical JSON sorts the keys
    expect(hashJson({ args: { qty: 2.5, id: "b1" }, op: "restock" })).toBe(BINDING);
  });

  it("writes a number in one form, whatever the client sent", () => {
    // JSON.parse gives the value, not the literal, so 2.50 and 2.5 reach the hash as one number
    expect(hashJson(JSON.parse('{"args":{"id":"b1","qty":2.50},"op":"restock"}'))).toBe(BINDING);
    const forms: Array<[unknown, string]> = [
      [2.5, "2.5"],
      [1.0, "1"],
      [-0, "0"],
      [0.0001, "0.0001"],
      [1e-6, "0.000001"],
      [1e-7, "1e-7"],
      [1e20, "100000000000000000000"],
      [1e21, "1e+21"],
      [123456789012345678901234567890, "1.2345678901234568e+29"],
    ];
    for (const [value, written] of forms) expect(canonicalJson(value), `the number ${String(value)}`).toBe(written);
  });

  it("scopes a viewer by the same rule", () => {
    expect(hashJson({ id: "u1", tier: 2 })).toBe(VIEWER);
    expect(hashJson({ tier: 2.0, id: "u1" })).toBe(VIEWER);
  });

  it("nesting, strings, booleans and nulls are untouched by the number rule", () => {
    expect(canonicalJson({ a: [1.0, "1.0", true, null, { b: 2.5 }], z: "x" })).toBe('{"a":[1,"1.0",true,null,{"b":2.5}],"z":"x"}');
  });
});
