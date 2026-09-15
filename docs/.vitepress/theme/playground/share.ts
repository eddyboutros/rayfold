/** A playground setup in the address bar, so a link reopens exactly what was on screen. */
import { base64url, fromBase64url } from "@rayfold/schema";
import type { ViewerName } from "./examples.ts";

export interface Shared {
  /** left out while it is the bookshop schema, to keep links short */
  schema?: string;
  request: string;
  viewer: ViewerName;
}

const VIEWERS: readonly ViewerName[] = ["anonymous", "customer", "staff"];

export function toHash(state: Shared): string {
  return `#s=${base64url(JSON.stringify(state))}`;
}

export function fromHash(hash: string): Shared | null {
  const match = /^#s=([A-Za-z0-9_-]+)$/.exec(hash);
  if (!match) return null;
  try {
    const value = JSON.parse(fromBase64url(match[1]!)) as Partial<Shared>;
    if (typeof value.request !== "string" || !VIEWERS.includes(value.viewer as ViewerName)) return null;
    return { request: value.request, viewer: value.viewer as ViewerName, ...(typeof value.schema === "string" ? { schema: value.schema } : {}) };
  } catch {
    return null;
  }
}
