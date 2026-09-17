/**
 * What `@http` says about an operation: the method, the path and how the body maps onto arguments (spec 04 §8).
 * Reading the annotations is pure, so this lives apart from the Node handler that serves the routes and from the
 * OpenAPI document that describes them - both read it, and a runtime without Node can too.
 */
import { annotation, type OpDef, type RayfoldSchemaIR } from "@rayfold/schema";

export const QUERY_METHODS = ["GET", "QUERY"] as const;
export const COMMAND_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;
/** Methods whose HTTP semantics are idempotent: a command bound to them may run without an Idempotency-Key. */
export const IDEMPOTENT_METHODS = new Set(["PUT", "PATCH", "DELETE"]);

export interface Binding {
  op: OpDef;
  method: string;
  path: string;
  /** name of the argument that receives the JSON body, or "*" to spread the body into the arguments */
  body?: string;
  /** Location template for 201 responses, filled from the result, e.g. "/orders/{id}" */
  location?: string;
  params: string[];
  regex: RegExp;
}

export function bindingsOf(ir: RayfoldSchemaIR): Binding[] {
  const out: Binding[] = [];
  for (const op of Object.values(ir.ops)) {
    const a = annotation(op, "http");
    if (!a) continue;
    const method = identOrString(a.args["method"])?.toUpperCase();
    const path = typeof a.args["path"] === "string" ? a.args["path"] : undefined;
    if (!method || !path) continue;
    const params: string[] = [];
    const pattern = path.replace(/[.*+?^()|[\]\\]/g, "\\$&").replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
      params.push(name);
      return "([^/]+)";
    });
    const b: Binding = { op, method, path, params, regex: new RegExp(`^${pattern}$`) };
    const body = identOrString(a.args["body"]);
    if (body) b.body = body;
    if (typeof a.args["location"] === "string") b.location = a.args["location"];
    out.push(b);
  }
  return out;
}

function identOrString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "$ident" in v) return String((v as { $ident: string }).$ident);
  return undefined;
}
