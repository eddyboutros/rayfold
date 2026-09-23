---
title: Capability tokens
description: Short-lived, scoped, delegatable references to a viewer — hand an agent or a service exactly one class of operation, without handing over the user's credentials.
---

# Capability tokens

Sometimes something needs to act for a user without being that user: an AI agent placing one order, a background
worker finishing a checkout, another service reading one report. Giving it the user's session gives it everything the
user can do, for as long as the session lasts.

A **capability token** is the narrow alternative. It names a viewer, the operations its holder may call, and when it
expires. It is signed, so verifying one needs no storage and no round trip, and it can be narrowed further and passed
on.

This is the extension `cap`, defined in [spec 06 §6](../../spec/06-auth.md). It is TypeScript-only today; there is no
JVM equivalent.

## Mint one

```ts
import { Capabilities } from "@rayfold/server";

const caps = new Capabilities({ secret: process.env.CAP_SECRET!, maxTtlMs: 3_600_000 });

const token = caps.mint(
  { id: "u1", role: "customer" },
  { ops: ["book", "buy"], ttlMs: 60_000 },
);
```

The secret signs tokens, so it stays on the server; anything derived from it must not leave. `maxTtlMs` is the
longest life any token may have — one hour by default — and it bounds every token, minted or narrowed.

A token looks like this, and nothing in it is secret from its holder:

```
rfcap1.<payload as base64url JSON>.<HMAC-SHA256, base64url>
```

The payload is `{ viewer, ops, exp, jti, iss?, caps? }`. A token is a reference, not a password: the signature is
what stops it being edited, not obscurity.

## Use one as the viewer

Turn a token into the viewer for a request, where you would otherwise read a session:

```ts
const handler = createHttpHandler(server, {
  viewer: (req) => {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    return token.startsWith("rfcap1.") ? caps.viewerOf(token) : sessionViewer(req);
  },
});
```

`viewerOf` verifies the signature and the expiry, and answers the viewer the token speaks for with the token's own
facts under `caps`. Two things then happen on every request:

- **The operation list is enforced by the runtime.** A holder calling anything outside `ops` is refused with
  `permission_denied`, before the operation runs and whatever the schema's policies say.
- **The schema's policies still run**, unchanged, on the viewer the token names. A token is a narrowing, never a
  widening: it cannot grant what the viewer could not already do.

Policies can read the token's facts as `viewer.caps.*` — `viewer.caps.jti`, `viewer.caps.exp`, `viewer.caps.iss`, and
anything you passed as `caps` when minting:

```rayfold
command refund(orderId: ID): Order @allow(write: viewer.caps.iss == "support-console")
```

## Narrow and pass on

A holder that wants a narrower token asks the server that minted it, which derives one without the secret ever
leaving it:

```ts
const narrower = caps.attenuate(token, { ops: ["book"], ttlMs: 10_000 });
```

Attenuation only ever takes away. The new token's operations are a subset of the old one's, its life is no longer,
and a fact the parent did not carry cannot appear — a derived token may drop `caps` entries but never add or change
one. Removal is the one narrowing a server can verify without knowing what a fact means.

## Keeping them safe

- **Keep lives short.** Minutes, not days. A token cannot be revoked — expiry is the whole revocation story — so its
  life is the blast radius. `jti` names a token if you want to keep your own deny list.
- **Give the smallest `ops` that works.** The list is what the runtime enforces; everything else is your schema's
  policies doing their usual job.
- **Treat it as a credential in transit.** It is not secret from its holder, but anyone who has it is its holder.
- **Do not put anything in `caps` you would not show the holder.** The payload is readable base64url.

`cap` is not negotiated through the manifest, and a server does not list it in `extensions` — there is nothing for a
client to negotiate, since a holder that has a token simply presents it.

## Next

- [Who can do what](../learn/auth.md) — the policies that run on the viewer a token names.
- [MCP for AI agents](./mcp.md) — the most common reason to want one.
