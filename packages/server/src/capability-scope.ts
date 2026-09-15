/**
 * Whether a viewer holding a capability may call this operation. A viewer without `caps.ops` is not a capability
 * holder and is left to the schema's own policies.
 *
 * Kept apart from capability.ts, which signs tokens with node:crypto: the batch needs only this check, and the batch
 * has to run anywhere, browsers included.
 */
export function capabilityAllows(viewer: unknown, op: string): boolean {
  if (!viewer || typeof viewer !== "object" || Array.isArray(viewer)) return true;
  const caps = (viewer as { caps?: unknown }).caps;
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) return true;
  const ops = (caps as { ops?: unknown }).ops;
  if (!Array.isArray(ops)) return true;
  return ops.includes(op);
}
