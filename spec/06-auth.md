# 06 — Authorization

Authorization in Rayfold is declared in the schema and evaluated by the runtime before and during execution.
There is no separate middleware layer to keep in sync with the types, and the same declarations drive cache
scope ([07](07-cache.md)), the manifest ([10](10-mcp-bridge.md)) and static analysis.

## 1. Principal

The transport layer authenticates the caller and produces the **viewer**: an arbitrary JSON object supplied
by the server (`{ id, role, scopes, tenant, … }`). Anonymous callers get `viewer = null`. How a token becomes a
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
| Field, explicitly selected | `permission_denied` with `path`, whole op fails (atomic), unless the field is `@partial` → `null` + partial error. |
| Type, explicitly selected, at a nullable position | `null`, exactly as for an entity that does not exist, so a denial never reveals that the entity exists ([12 §5](12-security.md)). |
| Type, explicitly selected, at a non-null position or as a list element | `permission_denied` with `path`, whole op fails (atomic). |
| Type or field, field only in a default view | Field omitted silently. Default views never leak and never fail. |

An expression that cannot be evaluated, such as ordering text against a boolean, fails closed: `@allow` does not
allow and `@deny` denies. Numbers and numeric text (Decimal and Long travel as text) compare exactly by value
([12 §5](12-security.md)).

## 4. Pushdown

A policy that references only `viewer`, `args`, literals and scalar fields of `this` is **pushable**: the
runtime hands it to the loader as a filter predicate (`ctx.policy.filter`) so that list queries never fetch
rows the viewer cannot see. Loaders that do not implement pushdown get the runtime's post-filter, which is
correct but pays the cost. `rayfold explain` reports which policies were pushed down.

## 5. Cost budgets

Every op has a static cost: its `@cost.base` (default 1) plus `@cost.perItem × first` for pages, plus the cost of
every field the shape selects. A field costs its own `@cost.base` plus `@cost.perItem ×` its page size, multiplied
by the page sizes that enclose it. A field's base defaults to 1 when it returns objects (an entity, an object, a page
or a list of them) and to 0 when it returns scalars or enums, which arrive with the row already loaded. The perItem of
a page, whether an op or a field returns it, defaults to 1, so every row a page can return is charged. The budget
measures rows and loads, not columns.
The viewer's budget (server-configured, default 1 000 per batch and 10 000 per minute) is checked before
execution; exceeding it is `resource_exhausted` with `data: { cost, budget }`. Actual cost is reported in
`meta.cost`.

## 6. Capability tokens (extension `cap`)

A server MAY issue **capability tokens**: short-lived, scoped, delegatable references to a viewer with a
narrowed policy environment (`viewer.caps`). They let an agent or downstream service perform exactly one
class of operation without holding the user's credentials. Defined in the `cap` extension.
