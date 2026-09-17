# 01 - Schema

A Rayfold schema is written in the `.rayfold` language or produced by a code-first builder. Both produce the same
canonical **IR** (JSON, section 9). Everything else in Rayfold (execution, caching, auth, evolution checks,
codegen, the MCP bridge) consumes the IR, never the source text.

## 1. Lexical structure

* Encoding UTF-8. Whitespace and commas are insignificant separators.
* Comments: `// line` and `/* block */`.
* Documentation: a `"""triple-quoted"""` string immediately before a definition, field, argument or enum
  value is its description. Descriptions are part of the IR (they are what agents and playgrounds see).
* Names: `[A-Za-z_][A-Za-z0-9_]*`. Type names SHOULD be `PascalCase`, fields and operations `camelCase`.
  Names starting with `__` or `$` are reserved.
* Literals: integers, floats, `"strings"` (JSON escapes), `true`/`false`/`null`, durations (`60s`, `5m`,
  `2h`, `7d`, `250ms`), lists `[...]`, objects `{ key: value }`.

## 2. Definitions

```
document     := definition*
definition   := entity | object | input | enum | union | scalar | error | event
              | view | query | command | stream
```

### 2.1 `entity`

An entity has identity. It MUST declare a field `id: ID`. Its global identity on the wire and in caches is
the string `TypeName:id`.

```
entity Book @cache(maxAge: 60s, scope: public) {
  id: ID
  title: String
  price: Money @allow(read: viewer.role == "admin" || viewer.id == ownerId)
  author: Author @load(batch)
  reviews(first: Int = 10, after: String?): Page<Review>
  ownerId: ID
}
```

An entity MAY declare `implements Iface1, Iface2` (interfaces are `object` definitions marked
`@interface`; the entity MUST include all interface fields).

### 2.2 `object`

A value type without identity. Same field syntax; no `id` requirement. Objects are never cached on their own
and never patched; they live inside the entity or result that contains them.

### 2.3 `input`

An argument-only type. Fields MAY have defaults. Inputs MUST NOT reference entities or objects, only
scalars, enums and other inputs.

### 2.4 `enum`, `union`, `scalar`

```
enum Format { HARDCOVER PAPERBACK EBOOK }
union SearchHit = Book | Author
scalar Money @format("decimal")
```

Built-in scalars: `ID`, `String`, `Int` (32-bit), `Long` (64-bit; JSON encodes as string when it exceeds
2^53), `Float`, `Boolean`, `Decimal` (JSON string), `Instant` (RFC 3339 UTC), `Date` (`YYYY-MM-DD`),
`Duration` (`250ms`, `60s`, `5m`, `2h`, `7d`, or a whole number of milliseconds), `Bytes` (base64url), `JSON` (any
value), and the generic `Page<T>`.

### 2.5 `error`

A named, reusable domain error. Fields describe the structured payload.

```
error OutOfStock { bookId: ID, available: Int }
```

Errors MAY also be declared inline in a `throws` clause (2.8) and are then hoisted into the IR as named errors.

### 2.6 `event`

A published fact. Events have fields and are immutable. The runtime stamps `seq`, a per-server arrival counter, on
delivery; it is not a field of the type and does not appear in the IR.

```
event OrderPlaced { orderId: ID }
```

### 2.7 `view`

A named shape (see [02](02-shapes.md)) attached to a type. The view named `default` is what a caller
gets when it sends no shape. If a type declares no `default` view, its default view is every scalar and enum field
that takes no arguments (which includes the `id`); nested entities and objects are left out entirely rather than
reduced to their `id`. The built-in `Page` is the one exception: its derived default view includes `items`,
projected through the element type's own default view, since a window with no rows in it would answer nothing.

```
view Book.default = { id title author { name } }
view Book.card    = { ...Book.default price }
```

### 2.8 Operations

```
query   books(filter: BookFilter?, page: PageArgs = { first: 20 }): Page<Book> @cost(base: 5, perItem: 1)
command placeOrder(input: OrderInput): Order
        throws OutOfStock | PaymentDeclined { reason: String }
        emits OrderPlaced
stream  inventory(bookIds: [ID]): InventoryUpdate
```

| Kind | Semantics |
|---|---|
| `query` | Safe and idempotent. Cacheable per [07](07-cache.md). Shapeable. May be requested `live` when the `live` extension is present. |
| `command` | Changes state. A client MUST send an idempotency `key`. Returns the declared result **plus patches** ([04 §4](04-frames-and-transport.md)). May declare `throws` (typed errors, [05](05-errors.md)) and `emits` (events). |
| `stream` | Produces zero or more items of the return type until `fin`. Bidirectional when annotated `@input(Type)`: the client sends items of `Type` as `item` frames. |

Events are consumed by declaring a `stream` that returns the event type. The name `subscribe` is reserved for a
built-in subscription with replay, which is not specified or implemented in 0.1.

## 3. Fields, arguments and types

```
field   := doc? name args? ":" type default? annotation*
args    := "(" (doc? name ":" type default?)* ")"
type    := named | named "?" | "[" type "]" | "[" type "]" "?" | named "<" type ("," type)* ">" ("?")?
```

**Nullability is opt-in.** `String` is non-null; `String?` may be null. A list `[String]` is a non-null list
of non-null strings; `[String?]?` allows both. This is the reverse of GraphQL and matches how APIs are
actually used: most fields are required.

Defaults are permitted on arguments and input fields. A default implies the argument is optional at the
call site but non-null in the resolver.

## 4. Annotations

Annotations attach machine-readable policy to a definition or field. Core annotations:

| Annotation | On | Meaning |
|---|---|---|
| `@cache(maxAge: Duration, scope: public \| private, swr: Duration?)` | entity, query | Freshness and cache scope ([07](07-cache.md)). |
| `@allow(read: Expr?, write: Expr?)` | entity, object, field, operation | Policy expression; absent means allowed ([06](06-auth.md)). |
| `@deny(read: Expr?, write: Expr?)` | same | Explicit denial; evaluated after `@allow`. |
| `@load(batch \| single)` | field | Loader shape. Default is `batch`. `single` marks a field the executor may resolve one parent at a time. |
| `@page(cursor \| offset)` | field or query returning `Page<T>` | Pagination style. Default `cursor`. |
| `@cost(base: Int, perItem: Int?)` | field, query, command, stream | Static cost hint for budgets. Default `base`: 0 on scalar and enum fields, 1 elsewhere; default `perItem`: 1 on pages, 0 elsewhere ([06 §5](06-auth.md)). |
| `@idempotent(false)` | command | The command takes no idempotency key, and one sent with it is refused ([03 §4](03-batch-and-pipelining.md)). |
| `@merge(serverWins \| keepLocal \| lww \| crdtText \| custom)` | field | How an optimistic prediction for the field settles against the server's answer ([08 §5](08-live-and-sync.md)). |
| `@simulate` | command | The resolver honours `ctx.simulate`, so the command accepts dry runs. Without it, `simulate: true` is `failed_precondition` and the MCP bridge offers no `.simulate` tool ([12 §6](12-security.md)). |
| `@deprecated(reason: String?, sunset: Date?, replacement: String?)` | anything | See [11](11-evolution.md). Tooling refuses removal before `sunset`. |
| `@lazy` | field | Field is delivered in a later frame unless the shape asks for it eagerly. |
| `@partial` | field | The field may fail without failing the operation; the client receives `null` and an entry in the frame's `errors`. |
| `@live(false)` | query | Query cannot be subscribed to. |
| `@input(Type)` | stream | Bidirectional stream; client items are of `Type`. |
| `@interface` | object | Declares an interface. |
| `@range(min: Number?, max: Number?)` | scalar, field, arg | **Enforced before execution** by the declared type (numbers and Decimals by value, strings and lists by length) on arguments and input fields the caller actually sent: a violating one is `invalid_argument` with a path, and no resolver runs. A default that is never sent is not checked, and `@range` on a result field is a hint only. |
| `@format(String, pattern: String?)`, `@unit(String)` | scalar, field, arg | Machine-readable hints for docs and agents; `pattern` is enforced on strings. |
| `@example(value)` | scalar, field, arg, any operation, and `entity`, `object` and `input` types | A sample value for docs, the explorer and agents. |
| `@version` | entity field (`Int`, `Long`, `String` or `Instant`) | The entity's version for conditional commands ([03 §4a](03-batch-and-pipelining.md)). Bumped by the resolver on every write. |
| `@http(method: M, path: String, body: Name \| "*"?, location: String?)` | query, command | HTTP binding ([04 §8](04-frames-and-transport.md)). Queries bind `GET` or `QUERY`; commands bind `POST`, `PUT`, `PATCH` or `DELETE`. `{name}` path segments are arguments. |
| `@ordinal(Int)` | field, enum value | Fixes the wire ordinal used by RB ([09](09-binary-format.md)). Normally assigned by the lockfile. |

Unknown annotations MUST be rejected unless namespaced (`@vendor.name(...)`), in which case they are preserved on the
node's own `annotations` list under the full `vendor.name` and ignored by conformant implementations that do not know
them.

## 5. Policy expressions

Used by `@allow` / `@deny`. Grammar:

```
expr    := or
or      := and ("||" and)*
and     := not ("&&" not)*
not     := "!" not | cmp
cmp     := primary (("==" | "!=" | "<" | "<=" | ">" | ">=" | "in") primary)?
primary := literal | path | call | "(" expr ")"
path    := name ("." name)*
call    := name "(" (expr ("," expr)*)? ")"
```

Roots available in scope: `viewer` (the authenticated principal, shape defined by the server), `args`
(operation or field arguments), `this` (the current entity or object, for field and entity policies) and
bare names, which resolve to `this.<name>` on entities/objects and to `args.<name>` on operations.
Built-in calls: `has(list, value)`, `len(x)`, `now()`.
Expressions are pure: a missing path evaluates to `null`, `==` and `!=` treat a missing path and `null` as equal,
**ordering** comparisons with `null` are `false`, and `in` tests list membership. They are total but for one case:
ordering two values that cannot be ordered is an evaluation error, which fails closed ([06 §3](06-auth.md)).

## 6. Generic `Page<T>`

`Page<T>` is a built-in object:

```
object Page<T>  { items: [T], cursor: String?, hasMore: Boolean, total: Int? }
input  PageArgs { first: Int = 20, after: String?, offset: Int? }
```

A field or query returning `Page<T>` MUST accept a `page: PageArgs` argument or the individual `first`/`after`
arguments. A server MUST cap `first` (default cap 200) before the resolver sees it; returning no more than `first`
items is then the resolver's own obligation, which the runtime does not enforce for it.

## 7. Reserved names

`$type` and `__*` as field names; `subscribe`, `manifest`, `simulate` and `sync` as operation names. `viewer`, `args`
and `this` are the roots of policy expressions ([06](06-auth.md)) rather than reserved names: a field or operation may
carry any of them.

## 8. Validation rules (normative)

An IR is valid when:

1. Every referenced type exists; no name is defined twice (types, errors, events and views share one namespace with operations in a second namespace).
2. Every `entity` has `id: ID` (non-null).
3. `input` types reference only scalars, enums and inputs. Operation arguments likewise.
4. Operation results and entity/object fields reference only entities, objects, scalars, enums, unions and `Page<T>`;
   a `stream` result may also be an `event` type ([§2.6](#26-event)).
5. `throws` references only `error` definitions; `emits` only `event` definitions.
6. Every `view` references an existing type and every selected field exists on it (recursively).
7. Every `@allow`/`@deny` expression parses and references only paths rooted in the allowed roots.
8. `@page` appears only on fields and queries returning `Page<T>`; `@input` only on streams; `@live` only on queries.
9. Every entity, object and union type is reachable from at least one operation, event or view (unreachable types are a warning, not an error).
10. Reference cycles between entities are allowed; the executor bounds depth per [02 §5](02-shapes.md).

## 9. IR

The IR is a JSON document: the schema after parsing, with every default resolved and every reference checked. It is
what the manifest serves, what RB derives its key dictionary from, and what the schema hash is taken over — so it is
given here in full rather than by reference to any implementation. An implementation that produces this structure
from the same schema text produces the same hash, which is the only way a third party can join a fleet.

**Two rules apply throughout**, and they are what make the hash stable:

* An **optional member appears only when it has a value.** A `description` nobody wrote is absent, not `null` or `""`.
* A **flag appears only when true.** `builtin`, `interface`, `eager` and `partial` are present-and-`true` or absent.

### 9.1 Document

| Member | Always | Meaning |
|---|---|---|
| `rayfold` | yes | `"0.1"` |
| `types` | yes | type name → [TypeDef](#93-typedef) |
| `ops` | yes | operation name → [OpDef](#94-opdef) |
| `views` | yes | `"Type.name"` → [ViewDef](#95-viewdef-and-shape) |
| `extensions` | no | vendor data, namespaced by the vendor |

**`extensions` is excluded from the hashed form.** Everything else is included. A conformant implementation ignores
vendor data it does not know ([§4](#4-annotations)), so an identity that moved with it would make two servers
offering the same conversation look different, and a gateway that strips vendor metadata look like a schema change.

### 9.1a The built-in definitions

**Every IR contains these before a single line of schema is read**, each carrying `builtin: true`. They are part of
what is hashed, so an implementation that omits them agrees with nobody about anything — this is the first thing to
get right, and the first thing to check when a hash does not match.

* The twelve scalars of [§2.4](#24-enum-union-scalar), each `{kind: "scalar", builtin: true, annotations: []}`:
  `ID`, `String`, `Int`, `Long`, `Float`, `Boolean`, `Decimal`, `Instant`, `Date`, `Duration`, `Bytes`, `JSON`.
* **`Page`**, an `object` with `typeParams: ["T"]` and four fields, in this order and with these ordinals:
  `items: [T]` (1), `cursor: String?` (2), `hasMore: Boolean` (3), `total: Int?` (4).
* **`PageArgs`**, an `input` with three fields: `first: Int` defaulting to `20` (1), `after: String?` (2),
  `offset: Int?` (3).

A schema may not redefine any of them ([§8](#8-validation-rules-normative) rule 1).

### 9.2 TypeRef

A reference to a type, at a field, an argument or a return position.

| Member | Always | Meaning |
|---|---|---|
| `kind` | yes | `"named"` or `"list"` |
| `nullable` | yes | whether `null` is a value here |
| `name` | on `named` | the type's name |
| `args` | no | type arguments, a list of TypeRef — `Page<Book>` is `{kind:"named", name:"Page", args:[Book]}` |
| `of` | on `list` | the element's TypeRef |

### 9.3 TypeDef

Every type carries `kind`, `name` and `annotations`; `description` when written; `builtin` when true. The rest is
by kind:

| `kind` | Also carries |
|---|---|
| `entity` | `fields` ([FieldDef](#96-fielddef-argdef-and-enumvaluedef)), `implements` (interface names, possibly empty) |
| `object` | `fields`; `typeParams` when the type is generic; `interface` when true |
| `input` | `fields` |
| `error` | `fields` |
| `event` | `fields` |
| `enum` | `values` ([EnumValueDef](#96-fielddef-argdef-and-enumvaluedef)) |
| `union` | `members`, the member type names |
| `scalar` | nothing further |

### 9.4 OpDef

| Member | Always | Meaning |
|---|---|---|
| `kind` | yes | `"query"`, `"command"` or `"stream"` |
| `name` | yes | |
| `description` | no | |
| `args` | yes | a list of ArgDef, possibly empty |
| `returns` | yes | TypeRef |
| `throws` | yes | declared error type names, possibly empty |
| `emits` | yes | declared event type names, possibly empty |
| `annotations` | yes | possibly empty |

### 9.5 ViewDef and Shape

A ViewDef is `type`, `name` and `shape`. A Shape is one member, `items`, a list of shape items. Each item carries
`kind` and then:

| `kind` | Also carries |
|---|---|
| `field` | `name`; `alias`, `args`, `shape` when present; `eager`, `partial` when true |
| `spread` | `type`, `view` |
| `on` | `type`, `shape` |
| `defer` | `shape`; `label` when present |

A shape item's `args` is an object of argument name → value, where a variable reference is `{"$var": "name"}`.
Shape *text* and its canonical form are [02 §3](02-shapes.md); this is the parsed form the IR carries.

### 9.6 FieldDef, ArgDef and EnumValueDef

| Member | FieldDef | ArgDef | EnumValueDef |
|---|---|---|---|
| `name` | yes | yes | yes |
| `description` | when written | when written | when written |
| `type` | yes | yes | — |
| `args` | yes, possibly empty | — | — |
| `default` | when the field is an `input` field with one | when declared | — |
| `annotations` | yes, possibly empty | yes, possibly empty | yes, possibly empty |
| `ordinal` | yes | — | yes |

`ordinal` is a stable integer assigned at first publication and recorded in `rayfold.lock.json`; ordinals are
reserved for a future compact-struct encoding ([09 §3](09-binary-format.md)) and are what `rayfold check` protects
against changing.

### 9.7 Annotation and its values

An annotation is `name` and `args`, an object of argument name → value. Values are JSON, except that four things
which are not JSON are carried as single-member tagged objects:

| Tag | Carries |
|---|---|
| `{"$ident": "..."}` | a bare identifier, such as `cursor` in `@page(cursor)` |
| `{"$duration": 60000}` | a duration, in **milliseconds** — the schema's `60s` and `60000` are one value |
| `{"$expr": ...}` | a policy expression, as the AST of [§5](#5-policy-expressions) |
| `{"$type": ...}` | a TypeRef, such as the argument of `@input(Type)` |

A policy expression node is one of: `{"k":"lit","v":...}`; `{"k":"path","root":"viewer"\|"args"\|"this","path":[...]}`;
`{"k":"bin","op":...,"l":...,"r":...}`; `{"k":"not","e":...}`; `{"k":"call","fn":...,"args":[...]}`;
`{"k":"list","items":[...]}`. A redacted manifest ([12 §5.6](12-security.md)) replaces an `allow` or `deny`
annotation's `args` with `{}` and leaves the annotation itself in place, so a reader still learns that a policy
exists without learning what it tests.

### Canonical JSON

The **schema hash** is the SHA-256 of the canonical IR, exposed in the manifest so clients can detect drift, and
the same form is what an idempotency record is scoped and bound by ([12 §4.2](12-security.md)). Two implementations
that write it differently do not fail loudly — they simply stop recognising each other's schemas and each other's
retries — so it is given exactly:

* **Object keys** are sorted ascending by **UTF-16 code unit**. Not by code point: an astral character is a surrogate
  pair beginning `0xD800`-`0xDBFF`, so it sorts *before* `U+E000`-`U+FFFF` rather than after. Not by any locale's
  collation either.
* **No insignificant whitespace**: nothing between a key and its `:`, its value, or the `,` that follows.
* **A member whose value is undefined is omitted**, as JSON has no such value. Null is a value and is kept.
* **Strings** carry `\"` and `\\`; the short forms `\b`, `\f`, `\n`, `\r`, `\t` for `U+0008`, `U+000C`, `U+000A`,
  `U+000D`, `U+0009`; and `\u00xx` in **lower-case** hexadecimal for any other character below `U+0020`. Every other
  character is written literally, `U+007F` and `U+2028`/`U+2029` included.
* **An unpaired surrogate** is written `\udxxx` in lower-case hexadecimal. It has no UTF-8 encoding, so writing it
  literally would contradict the encoding this form is defined in; escaping it keeps the text both valid JSON and
  encodable, and keeps the hash a function of the value.
* **Numbers** are as written, except where [12 §4.2](12-security.md) applies, which writes them in the one form
  every implementation derives from the value.
* The text is encoded as **UTF-8** before hashing.
