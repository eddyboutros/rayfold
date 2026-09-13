import { describe, expect, it } from "vitest";
import { loadSchema } from "@rayfold/schema";
import { bookstoreResolvers, bookstoreSchemaText, seed } from "../../../examples/bookstore-ts/src/index.ts";
import { checkWiring } from "./wiring.ts";
import type { Resolvers } from "./executor.ts";

const ir = loadSchema(bookstoreSchemaText()).ir;
const wired = (): Resolvers => bookstoreResolvers(seed());

/** A copy with one entry taken out, the way a rename or a deletion leaves a schema and its resolvers apart. */
function without(resolvers: Resolvers, group: string, member: string): Resolvers {
  const entries = resolvers as Record<string, Record<string, unknown> | undefined>;
  const copy: Record<string, Record<string, unknown> | undefined> = { ...entries, [group]: { ...entries[group] } };
  delete copy[group]![member];
  return copy as Resolvers;
}

/** The first field the schema gives arguments to: the runtime needs a loader for exactly those. */
function fieldWithArgs(): { type: string; field: string } {
  for (const type of Object.values(ir.types)) {
    if (type.builtin || !("fields" in type)) continue;
    for (const field of type.fields) if (field.args.length) return { type: type.name, field: field.name };
  }
  throw new Error("the bookstore schema has no field with arguments to test with");
}

describe("do the resolvers cover the schema", () => {
  it("says nothing about an example that is wired all the way", () => {
    expect(checkWiring(ir, wired())).toEqual([]);
  });

  it("finds an operation with no resolver, before a caller does", () => {
    const findings = checkWiring(ir, without(wired(), "Query", "book"));
    expect(findings).toEqual([
      {
        severity: "error",
        code: "missing-resolver",
        at: "book()",
        message: "No query resolver: every call fails with unimplemented. Add Query.book",
      },
    ]);
  });

  it("finds a field that takes arguments and has no loader", () => {
    const { type, field } = fieldWithArgs();
    const findings = checkWiring(ir, without(wired(), type, field));
    expect(findings).toEqual([
      {
        severity: "error",
        code: "missing-loader",
        at: `${type}.${field}`,
        message: "The field takes arguments, so it needs a loader: any shape asking for it fails with unimplemented",
      },
    ]);
  });

  it("guard - a field with no arguments needs no loader, because the parent carries it", () => {
    const plain = Object.values(ir.types).flatMap((t) => (!t.builtin && "fields" in t ? t.fields.filter((f) => !f.args.length).map((f) => ({ type: t.name, field: f.name })) : []));
    expect(plain.length).toBeGreaterThan(0);
    // nothing is wired for any of them in a schema that already passes, and the check stays silent
    expect(checkWiring(ir, wired())).toEqual([]);
  });

  it("finds a resolver the schema has no place for, which is what a rename leaves behind", () => {
    const entries = wired() as Record<string, Record<string, unknown> | undefined>;
    const renamed: Resolvers = {
      ...entries,
      Query: { ...entries["Query"], bookById: () => null },
      Shelf: { spine: () => null },
    } as Resolvers;

    const findings = checkWiring(ir, renamed).filter((f) => f.code === "unknown-resolver");
    expect(findings).toEqual([
      { severity: "warning", code: "unknown-resolver", at: "bookById()", message: "Query.bookById is wired, but the schema has no such operation" },
      { severity: "warning", code: "unknown-resolver", at: "Shelf", message: "Loaders are wired for Shelf, but the schema has no such type" },
    ]);
  });

  it("finds an operation wired under the wrong kind", () => {
    const entries = wired() as Record<string, Record<string, unknown> | undefined>;
    const command = Object.values(ir.ops).find((op) => op.kind === "command");
    expect(command).toBeDefined();
    const crossed = { ...entries, Query: { ...entries["Query"], [command!.name]: () => null } } as Resolvers;

    expect(checkWiring(ir, crossed).filter((f) => f.code === "unknown-resolver")).toEqual([
      { severity: "warning", code: "unknown-resolver", at: `${command!.name}()`, message: `${command!.name} is a command in the schema, but it is wired under Query` },
    ]);
  });

  it("finds a field wired on a type that no longer has it", () => {
    const entries = wired() as Record<string, Record<string, unknown> | undefined>;
    const withGhost = { ...entries, Book: { ...entries["Book"], blurb: () => null } } as Resolvers;

    expect(checkWiring(ir, withGhost).filter((f) => f.code === "unknown-resolver")).toEqual([
      { severity: "warning", code: "unknown-resolver", at: "Book.blurb", message: "Book.blurb is wired, but the schema has no such field" },
    ]);
  });
});
