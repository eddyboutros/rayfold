# 02 - Shapes

A **shape** says which fields of a result the caller wants. Shapes are what make Rayfold client-shaped without
giving up HTTP caching: a shape is canonicalised, hashed and can be persisted, so a read becomes a
`GET`/`QUERY` on a stable key.

## 1. Grammar

```
shape      := "{" item* "}"
item       := field | spread | defer
field      := (alias ":")? name args? shape? modifier*
args       := "(" (name ":" value)* ")"
value      := scalar | list | object | "$" name      // $name resolves from the op's `vars`, at any depth
scalar     := string | number | "true" | "false" | "null"
list       := "[" value* "]"
object     := "{" (name ":" value)* "}"
spread     := "..." Type "." viewName                // named view of that type
            | "..." "on" Type shape                  // type condition (unions, interfaces)
defer      := "@defer" ("(" "label" ":" string ")")? shape
modifier   := "@eager" | "@partial"
```

Commas are whitespace: a parser MUST accept them between items and between arguments, and the canonical form
([§3](#3-canonical-form-and-hashing)) drops them.

Example:

```
{
  id
  title
  author { id name }
  reviews(first: $n) { items { id rating } cursor hasMore }
  ...Book.card
  @defer(label: "stats") { salesRank }
  ...on Author { bio }
}
```

## 2. Semantics

* A field that is not selected is not resolved. A field with no sub-shape on an entity or object type
  receives that type's `default` view ([01 §2.7](01-schema.md)). So `{ id author }` is legal and returns the
  author's default view.
* No shape at all means the operation result's `default` view.
* `alias: name` renames the field in the output. Two selections of the same field with different args MUST use
  aliases.
* Spreads are flattened. A named-view spread copies the view's items. A type-condition spread contributes
  only when the concrete `$type` matches.
* `@defer` blocks are resolved after the enclosing frame is sent and delivered as `patch`-free `data`
  frames addressed by `at` ([04 §3](04-frames-and-transport.md)). Fields annotated `@lazy` in the schema
  behave as if wrapped in `@defer` unless the shape marks them `@eager`.
* `@partial` on a field lets that field fail independently ([05 §4](05-errors.md)).
* Every object in a result carries `"$type"` when the static type is an entity, union or interface;
  implementations MAY omit it for plain objects.

## 3. Canonical form and hashing

The canonical text of a shape is produced by:

1. Expanding named-view spreads (type-condition spreads stay).
2. Sorting items at each level by kind first — fields, then type conditions (`...on`), then `@defer` blocks, then
   named-view spreads — and within a kind: fields by output name (alias or field name) then canonical args, type
   conditions by type name, defers by label, spreads by `Type.view`.
3. Sorting args by name; encoding literal values as canonical JSON, numbers included
   ([12 §4.2](12-security.md)); keeping `$name` references verbatim.
4. Emitting with single spaces and no newlines: `{ author { id name } id title }`.

Separators are part of the identity, because the id is the hash of this text, so they are given exactly:

| Between | Separator |
|---|---|
| items of a shape | one space |
| arguments of a field | one space, each written `name: value` |
| members of a composite argument value | `,`, with the key quoted: `{"after":"r1","first":2}` |
| elements of a list argument value | `,` |

So a field with two arguments is `reviews(after: "r1" first: 2)` — the arguments are items, and items are separated
by a space — while the members *inside* a value are canonical JSON and separated by commas:
`reviews(page: {"after":"r1","first":2})`. The two rules meet in
`{ reviews(page: {"after":"r1","first":2}) { items { id rating } } }`.

The **shape id** is `sha256:` + lowercase hex SHA-256 of the canonical UTF-8 text.

An operation refers to its shape either inline (`"shape": "{ id title }"`) or by id
(`"shape": "sha256:..."`). Servers MUST accept inline shapes in development mode and MAY refuse them in
production (**trusted shapes**): with that mode on, the allowlist is the set of shapes the application registered,
one at a time, before serving. `rayfold shapes` prints the id of every shape in a file so a build can collect them;
registering each one is what puts it on the list.

## 4. Variables

`$name` inside shape args resolves from the operation's `vars` object. Persisted shapes keep their id
regardless of variable values; the cache key ([07](07-cache.md)) includes `args` and `vars`.

## 5. Limits

Servers MUST enforce a maximum nesting depth (default 8), a maximum number of selected fields (default 500)
and the cost budget ([06 §5](06-auth.md)). Exceeding a limit is `resource_exhausted` before execution.
