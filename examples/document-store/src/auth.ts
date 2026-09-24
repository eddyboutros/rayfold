/**
 * Who is signed in: the bearer token the identity provider issued, verified here, as in examples/typescript. A share's
 * capability token is the other kind of caller; documents.ts tells them apart.
 */
import { RayfoldError } from "@rayfold/server";
import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";
import type { Viewer } from "./resolvers.ts";

/** Signs development tokens when no identity provider is configured. Never set in production. */
const DEV_SECRET = new TextEncoder().encode("document store development key, not a secret");
const DEV_ISSUER = "http://localhost:4400/dev";

// In production, AUTH_JWKS_URL and AUTH_ISSUER name your identity provider; its published keys verify every token.
const jwks = process.env["AUTH_JWKS_URL"] ? createRemoteJWKSet(new URL(process.env["AUTH_JWKS_URL"])) : undefined;
const issuer = jwks ? process.env["AUTH_ISSUER"] : DEV_ISSUER;
if (!issuer) throw new Error("AUTH_ISSUER must be set with AUTH_JWKS_URL: a token from any other issuer is refused");

const verify = (token: string) =>
  jwks ? jwtVerify(token, jwks, { issuer, audience: "documents" }) : jwtVerify(token, DEV_SECRET, { issuer, audience: "documents" });

/** The signed-in viewer, or null for a request without a token; a token that does not verify is refused. */
export async function viewerFrom(authorization: string | undefined): Promise<Viewer | null> {
  if (!authorization) return null;
  const token = /^Bearer (\S+)$/.exec(authorization)?.[1];
  if (!token) throw new RayfoldError("unauthenticated", "Expected Authorization: Bearer <token>");
  try {
    const { payload } = await verify(token);
    return { id: String(payload.sub), name: typeof payload["name"] === "string" ? payload["name"] : String(payload.sub) };
  } catch {
    throw new RayfoldError("unauthenticated", "Invalid or expired token");
  }
}

/** A token as the identity provider would issue it, signed with the development key: for local runs and tests. */
export function devToken(sub: string, name: string): Promise<string> {
  return new SignJWT({ name }).setProtectedHeader({ alg: "HS256" }).setSubject(sub).setIssuer(DEV_ISSUER).setAudience("documents").setIssuedAt().setExpirationTime("8h").sign(DEV_SECRET);
}
