# 06 - Authorization

Authorization in Rayfold is declared in the schema and evaluated by the runtime before and during execution.
There is no separate middleware layer to keep in sync with the types, and the same declarations drive cache
scope ([07](07-cache.md)), the manifest ([10](10-mcp-bridge.md)) and static analysis.

## 1. Principal

The transport layer authenticates the caller and produces the **viewer**: an arbitrary JSON object supplied
by the server (`{ id, role, scopes, tenant, ... }`). Anonymous callers get `viewer = null`. How a token becomes a
viewer is out of scope for the protocol; Bearer/OAuth 2.1 is the conventional binding and MCP-facing servers
follow the MCP authorization profile.

## 2. Policies

`@allow(read: Expr, write: Expr)` and `@deny(read: Expr, write: Expr)` may appear on entities, objects,
fields and operations. Expressions follow [01 §5](01-schema.md).

* `read` governs queries, streams and the reading of fields inside any result (including command results).
* `write` governs commands and, on entities/fields, whether a command's declared input may target them
  (advisory to resolvers; enforced by generated adapters).

Evaluation for a field read, in order:

1. Operation-level policies (`@allow`/`@deny` on the op).
2. Type-level policies of the containing entity or object.
3. Field-level policies.

At each level, absent `@allow` means allowed; `@deny` evaluated true overrides. The result is allowed only
if every level allows. Policies are evaluated with `this` bound to the concrete parent object, so row-level
rules (`viewer.id == ownerId`) are natural.

## 3. Outcomes

| Where the denial happens | Outcome |
|---|---|
| Operation | `permission_denied` (or `unauthenticated` when `viewer` is null and the policy references it), no execution. |
| Field, explicitly selected | `permission_denied` with `path`, whole op fails (atomic), unless the field is `@partial` -> `null` + partial error. |
| Type, explicitly selected, at a nullable position | `null`, exactly as for an entity that does not exist, so a denial never reveals that the entity exists ([12 §5](12-security.md)). |
| Type, explicitly selected, at a non-null position or as a list element | `permission_denied` with `path`, whole op fails (atomic). |
| Field, only in a default view | Field omitted silently. Default views never leak and never fail. |
| Type, only in a default view | The member is present and `null`, as for a nullable position above: a default view never fails the operation. |

An expression that cannot be evaluated, such as ordering text against a boolean, fails closed: `@allow` does not
allow and `@deny` denies. Numbers and numeric text (Decimal and Long travel as text) compare exactly by value
([12 §5](12-security.md)).

## 4. Pushdown

A policy that references only `viewer`, `args`, literals and scalar fields of `this` is **pushable**: the
runtime hands it to the loader as a filter predicate on the context so that list queries never fetch rows the viewer
cannot see. Where on the context is the runtime's own business — the TypeScript runtime uses `ctx.policy.filter`, the
Kotlin one `ctx.policy`. Loaders that do not implement pushdown get the runtime's post-filter, which is
correct but pays the cost. `rayfold explain` reports which policies were pushed down.

## 5. Cost budgets

Every op has a static cost: its `@cost.base` (default 1) plus `@cost.perItem × first` for pages, plus the cost of
every field the shape selects. A field costs its own `@cost.base` plus `@cost.perItem ×` its page size, multiplied
by the page sizes that enclose it. A field's base defaults to 1 when it returns objects (an entity, an object, a page
or a list of them) and to 0 when it returns scalars or enums, which arrive with the row already loaded. The perItem of
a page, whether an op or a field returns it, defaults to 1, so every row a page can return is charged. The budget
measures rows and loads, not columns.
The viewer's budget (server-configured, default 1 000 per batch) is checked before execution; exceeding it is
`resource_exhausted` with `data: { cost, budget }`. Actual cost is reported in `meta.cost`. Every op that is estimated
costs at least 1, however cheap its parts; an op refused before it is estimated, such as one whose arguments do not
validate, costs nothing and is not counted against the batch. Rate limiting over time is left to the deployment.

## 6. Capability tokens (extension `cap`)

A server MAY issue **capability tokens**: short-lived, scoped, delegatable references to a viewer. They let an agent
or a downstream service perform exactly one class of operation without ever holding the user's credentials.

Unlike the other extensions, `cap` is **not negotiated through the manifest**, and a server does not list it in
`extensions` ([04 §4a](04-frames-and-transport.md)). There is nothing for a client to negotiate: a token is a bearer
credential presented where any other credential would be, and a holder that has one uses it without asking what the
server supports. So 04's rule that a client MUST NOT use an unlisted extension does not reach this one.

A token carries what it claims and is signed, so verifying one needs no storage and no round trip:

```
rfcap1.<payload as base64url JSON>.<HMAC-SHA256 over "rfcap1.<payload>", base64url>
```

The payload is `{ viewer, ops, exp, jti, iss?, caps? }`: the viewer it speaks for, the operation names its holder may
call, the epoch milliseconds after which it is refused, an id naming this token, optionally who issued it, and
optionally extra facts. Nothing in it is secret from its holder: a token is a reference, not a password, and the
signature is what stops it being edited.

A server that accepts a token MUST refuse it when the signature does not match, when the payload is not readable, or
when `exp` has passed, each as `unauthenticated`. The viewer it yields carries `caps` (`{ ops, exp, jti, iss?, ... }`),
which the schema's policies read as `viewer.caps.*`, and the runtime MUST refuse any operation not named in
`caps.ops` with `permission_denied`, before the operation runs. A viewer without `caps.ops` is not a capability
holder and is governed by the schema's policies alone.

**Attenuation only narrows.** A token derived from another MAY drop operations and shorten the life; it MUST NOT add
an operation, extend `exp` beyond the token it came from, or carry a fact in `caps` that its parent did not.
A derived token is a token in its own right and may be narrowed again, so a chain of delegations can only ever lose
authority.
