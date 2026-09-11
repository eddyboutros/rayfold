/** Policy evaluation. Spec: spec/06-auth.md. */
import { evalExpr, isPushable, referencesViewer, type Annotation, type Expr, type ExprEnv } from "@rayfold/schema";
import { RayfoldError } from "./protocol.ts";

export type PolicyMode = "read" | "write";

interface Policies {
  allow?: Expr;
  deny?: Expr;
}

const cache = new WeakMap<Annotation[], Record<PolicyMode, Policies>>();

export function policiesOf(annotations: Annotation[], mode: PolicyMode): Policies {
  let entry = cache.get(annotations);
  if (!entry) {
    entry = { read: extract(annotations, "read"), write: extract(annotations, "write") };
    cache.set(annotations, entry);
  }
  return entry[mode];
}

function extract(annotations: Annotation[], mode: PolicyMode): Policies {
  const out: Policies = {};
  for (const a of annotations) {
    if (a.name !== "allow" && a.name !== "deny") continue;
    const v = a.args[mode];
    if (v && typeof v === "object" && "$expr" in v) out[a.name] = (v as { $expr: Expr }).$expr;
  }
  return out;
}

export function hasPolicy(annotations: Annotation[], mode: PolicyMode): boolean {
  const p = policiesOf(annotations, mode);
  return p.allow !== undefined || p.deny !== undefined;
}

export type Decision = "allow" | "deny" | "unauthenticated";

/** Absent allow = allowed; deny evaluated after allow. Viewer-dependent denial with no viewer = unauthenticated. */
export function decide(annotations: Annotation[], mode: PolicyMode, env: ExprEnv): Decision {
  const p = policiesOf(annotations, mode);
  if (p.allow === undefined && p.deny === undefined) return "allow";
  const denied = (e: Expr) => (env.viewer === null || env.viewer === undefined) && referencesViewer(e) ? "unauthenticated" : "deny";
  // An expression that cannot be evaluated (say, ordering a string against a boolean) fails closed: it never allows
  // and always denies.
  const holds = (e: Expr): boolean | "error" => {
    try {
      return evalExpr(e, env) === true;
    } catch {
      return "error";
    }
  };
  if (p.allow !== undefined && holds(p.allow) !== true) return denied(p.allow);
  if (p.deny !== undefined && holds(p.deny) !== false) return denied(p.deny);
  return "allow";
}

export function decisionError(d: Exclude<Decision, "allow">, what: string): RayfoldError {
  return d === "unauthenticated"
    ? new RayfoldError("unauthenticated", `Sign in to access ${what}`)
    : new RayfoldError("permission_denied", `Not allowed to access ${what}`);
}

/** The read policy of a type if it can be pushed down to a loader as a filter (spec 06 §4). */
export function pushableFilter(annotations: Annotation[]): Expr | undefined {
  const p = policiesOf(annotations, "read");
  if (p.deny !== undefined) return undefined; // deny needs post-filter semantics
  if (p.allow !== undefined && isPushable(p.allow)) return p.allow;
  return undefined;
}
