---
title: Capability tokens
description: Short-lived, scoped, delegatable references to a viewer. Give an agent or a service the operations it needs without handing over the user's credentials.
---

# Capability tokens

Sometimes something needs to act for a user without being that user: an AI agent placing one order, a background
worker finishing a checkout, another service reading one report. Giving it the user's session gives it everything the
user can do, for as long as the session lasts.

A **capability token** gives it less. It names a viewer, the operations its holder may call, and when it expires. It
is signed, so verifying one needs no storage and no round trip. A holder can narrow it further and pass it on.

This is the extension `cap`, defined in [spec 06 §6](../../spec/06-auth.md). Only the TypeScript runtime mints and
verifies tokens today. The JVM runtime still enforces the operation list. If your viewer hook builds a viewer with
`caps.ops` (from a token a TypeScript service signed, for instance), that viewer can call only the operations listed.

## Mint one

```ts
import { Capabilities } from "@rayfold/server";

const caps = new Capabilities({ secret: process.env.CAP_SECRET!, maxTtlMs: 3_600_000 });

const token = caps.mint(
  { id: "u1", role: "customer" },
  { ops: ["book", "buy"], ttlMs: 60_000 },
);
```

The secret signs tokens, so it stays on the server, and nothing derived from it may leave. `maxTtlMs` is the longest
life any token may have (one hour by default). It applies to every token, minted or narrowed.

A token looks like this, and nothing in it is secret from its holder:

```
rfcap1.<payload as base64url JSON>.<HMAC-SHA256, base64url>
```

The payload is `{ viewer, ops, exp, jti, iss?, caps? }`. A token is a reference, not a password. The signature stops
anyone editing it; nothing in it is hidden.

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

`viewerOf` verifies the signature and the expiry. It returns the viewer the token names, with the token's own facts
under `caps`. Then, on every request:

- **The runtime enforces the operation list.** A call to anything outside `ops` is refused with `permission_denied`
  before the operation runs, whatever the schema's policies say.
- **The schema's policies still run**, unchanged, on the viewer the token names. A token can only narrow: it cannot
  grant what the viewer could not already do.

Policies can read the token's facts as `viewer.caps.*`: `viewer.caps.jti`, `viewer.caps.exp`, `viewer.caps.iss`, and
anything you passed as `caps` when minting:

```rayfold
command refund(orderId: ID): Order @allow(write: viewer.caps.iss == "support-console")
```

## Narrow and pass on

To get a narrower token, a holder asks the server that minted it. The server derives one, and the secret never leaves
it:

```ts
const narrower = caps.attenuate(token, { ops: ["book"], ttlMs: 10_000 });
```

Attenuation only takes away. The new token's operations are a subset of the old one's, and its life is no longer. A
derived token may drop `caps` entries but never add or change one, so a fact the parent did not carry cannot appear.
Removal is the one narrowing a server can verify without knowing what a fact means.

## Keeping them safe

- **Keep lives short.** Minutes, not days. A token cannot be revoked; it stops working only when it expires, so its
  life is how long a leaked copy stays usable. `jti` names a token if you want to keep your own deny list. A WebSocket opened with a
  token does not outlive it: at `exp` its open operations end with `unauthenticated` and the socket closes with code
  `1008`.
- **Give the smallest `ops` that works.** The runtime enforces the list. Everything else is left to your schema's
  policies.
- **Treat it as a credential in transit.** It is not secret from its holder, but anyone who has it is its holder.
- **Do not put anything in `caps` you would not show the holder.** The payload is readable base64url.

`cap` is not negotiated through the manifest, and a server does not list it in `extensions`. A holder with a token
presents it; there is nothing for a client to negotiate.

## Next

- [Who can do what](../learn/auth.md): the policies that run on the viewer a token names.
- [MCP for AI agents](./mcp.md): the most common reason to want one.
