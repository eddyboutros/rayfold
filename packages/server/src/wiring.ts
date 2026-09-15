/**
 * Do the resolvers cover the schema?
 *
 * The runtime answers that one call at a time: an operation with no resolver fails with `unimplemented` when someone
 * calls it, and a field that takes arguments fails the same way when a shape asks for it and its parent does not
 * already carry it. Both are found in
 * production, by a user. This finds them at build time instead, and also finds the opposite - a resolver the schema
 * has no place for, which is what a rename leaves behind and what nothing reports at all.
 *
 *     const findings = checkWiring(schema.ir, resolvers);
 *     expect(findings).toEqual([]);          // in your own test suite
 *
 * `rayfold check schema.rayfold --resolvers ./src/resolvers.ts` runs the same check from the command line.
 */
import type { Diagnostic, OpKind, RayfoldSchemaIR } from "@rayfold/schema";
import type { Resolvers } from "./executor.ts";

const ROOT: Record<OpKind, "Query" | "Command" | "Stream"> = { query: "Query", command: "Command", stream: "Stream" };
const ROOTS = new Set(["Query", "Command", "Stream"]);

export function checkWiring(ir: RayfoldSchemaIR, resolvers: Resolvers): Diagnostic[] {
  const out: Diagnostic[] = [];
  const err = (code: string, at: string, message: string): void => void out.push({ severity: "error", code, at, message });
  const warn = (code: string, at: string, message: string): void => void out.push({ severity: "warning", code, at, message });
  const entries = resolvers as Record<string, Record<string, unknown> | undefined>;

  // what the schema declares, and the runtime would refuse
  for (const op of Object.values(ir.ops)) {
    if (!entries[ROOT[op.kind]]?.[op.name]) {
      err("missing-resolver", `${op.name}()`, `No ${op.kind} resolver: every call fails with unimplemented. Add ${ROOT[op.kind]}.${op.name}`);
    }
  }
  for (const type of Object.values(ir.types)) {
    if (type.builtin || !("fields" in type)) continue;
    for (const field of type.fields) {
      // a field with no arguments is read off the parent when there is no loader, which is a resolver shape of its own
      if (!field.args.length) continue;
      if (!entries[type.name]?.[field.name]) {
        err("missing-loader", `${type.name}.${field.name}`, `The field takes arguments, so it needs a loader: a shape asking for it fails with unimplemented unless the op's resolver already returns it`);
      }
    }
  }

  // what the resolvers wire that the schema no longer has: a rename leaves this behind and nothing says so
  for (const [key, members] of Object.entries(entries)) {
    if (!members) continue;
    if (ROOTS.has(key)) {
      const kind = key === "Query" ? "query" : key === "Command" ? "command" : "stream";
      for (const name of Object.keys(members)) {
        const op = ir.ops[name];
        if (!op) warn("unknown-resolver", `${name}()`, `${key}.${name} is wired, but the schema has no such operation`);
        else if (op.kind !== kind) warn("unknown-resolver", `${name}()`, `${name} is a ${op.kind} in the schema, but it is wired under ${key}`);
      }
      continue;
    }
    const type = ir.types[key];
    if (!type || type.builtin) {
      warn("unknown-resolver", key, `Loaders are wired for ${key}, but the schema has no such type`);
      continue;
    }
    if (!("fields" in type)) {
      warn("unknown-resolver", key, `Loaders are wired for ${key}, but a ${type.kind} has no fields to load`);
      continue;
    }
    for (const name of Object.keys(members)) {
      if (!type.fields.some((f) => f.name === name)) warn("unknown-resolver", `${key}.${name}`, `${key}.${name} is wired, but the schema has no such field`);
    }
  }

  return out;
}
