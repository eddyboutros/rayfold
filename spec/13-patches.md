# 13 - Patches and client state

Status: **Core**, as a clarification. This document adds no requirement that a conformant 0.1 implementation does
not already meet; it writes down semantics that were spread across [04 §2](04-frames-and-transport.md),
[07 §3](07-cache.md) and [08](08-live-and-sync.md) and never stated in one place. Sections marked **Reserved** are
0.2 candidates and are not usable today ([process.md](process.md)).

A patch is the mechanism the rest of the protocol leans on: a command says what it changed, a live query says what
moved, and a client's screens follow without asking again. So the question this document has to answer is not "can a
server send a patch?" but:

> **Can a client hold a correct picture of server state over time, and know when it cannot?**

## 1. What a client holds

A client is not required to keep a cache at all: a script or a service can read frames and ignore every patch
([07 §3](07-cache.md)). A client that does keep one holds three things:

| | |
|---|---|
| **Entities** | keyed `Type:id`, each a set of fields. One entity, however many results mention it. |
| **Results** | keyed by the operation and its arguments, shape and vars. A result holds the answer's structure with entities replaced by references, plus the set of entity keys it contains. |
| **Staleness** | which entities and which results have been marked as needing a refetch. |

Normalisation is what makes a patch worth sending: one `set` of `Book:b1` reaches every result that mentions that
book, so a screen showing it and a list containing it move together without either being refetched.

## 2. The operations

Four operations act on the cache as a whole and may appear in any `patch`, including a command's. Two more act on one
operation's own result and are valid only in a `patch` frame carrying an `id` ([04 §2b](04-frames-and-transport.md)).

| Op | Effect |
|---|---|
| `set` | Merge `value`'s fields into the entity, creating it if absent. **Field-level**: a named field replaces its old value entirely, an unnamed field is left alone. Nested entities in `value` are themselves stored and replaced by references. Clears staleness for that entity. |
| `del` | Remove the entity, and remove every reference to it — from results and from other entities' fields alike. |
| `inv` | Mark these entities stale. The client refetches on next read; it does not discard what it holds. |
| `invOp` | Mark every cached result of these operations stale. |
| `at` | Merge fields into the plain (non-entity) object at a dotted path of **this** result. `""` is the result itself. |
| `list` | At a dotted path of **this** result: remove the named positions, then insert the carried elements at their positions. |

`del` positions in a `list` name the list **as the client currently holds it**; `ins` positions are in the list after
those removals, applied in order. An `ins` carries the projected element in full, so the client stores its entities
and records which fields this result selected.

A server MUST NOT describe a change it cannot express with these operations — a reordering, a different set of
fields — and MUST send a fresh `data` frame instead. A client takes a `data` frame as a **replacement** for the
stored result, not a merge.

## 3. Applying one patch

* Operations are applied **in order**. A patch is a sequence, not a set: a `del` followed by a `set` of the same key
  is not the same as the reverse.
* Every operation is **total**: on a well-formed patch there is no operation that can fail. `set` creates what is
  absent, `del` removes what may already be gone, `inv` marks what it names, and the two result-scoped operations
  are ignored where the result is not held. So a client never faces a half-applied patch, and one that adds
  validation of its own MUST refuse the whole patch rather than the operations after the one it rejected.
* `at` and `list` on a result the client does not hold are **ignored**, not an error. A client only tracks the
  results it asked for.

## 4. Idempotence, and the one operation that is not

This is the property that decides what a client may safely do with a patch it is unsure about:

| Op | Applying it twice |
|---|---|
| `set` | Same result. A merge of the same fields is the same merge. |
| `del` | Same result. Removing what is gone removes nothing. |
| `inv`, `invOp` | Same result. |
| `at` | Same result, for the same reason as `set`. |
| **`list`** | **Corrupts.** It is positional: the second application deletes the wrong elements and inserts duplicates. |

So a client MUST NOT apply a `list` operation it may already have applied, and a server MUST NOT send one where
delivery is uncertain. In 0.1 this is not a hazard the protocol asks anyone to manage: frames arrive once, in order,
on one response, and a dropped subscription is re-established by refetch ([08 §4](08-live-and-sync.md)) rather than by
replaying what was missed. **It is, however, the reason a resume cursor cannot simply be bolted on** — see §7.

The invariant that follows, and the one worth testing:

> For one result, a client applies **every** patch frame in order, or it discards the result. There is no partial
> application and no gap-filling.

## 5. What a client does when

Each of these has one answer, and a client that improvises a different one drifts from every other client.

| Situation | What happens |
|---|---|
| **An entity is deleted** | `del`. Every reference to it goes: from lists, from other entities' fields, and from the root of a result — a result whose root entity was deleted holds `null`, which is what a nullable query would have answered anyway. Not an empty object, and not a dangling reference. |
| **A list gains or loses a member** | `list`, if the server can express it: the rows that moved, not the page. Otherwise a fresh `data` frame. |
| **A pagination boundary moves** | A fresh `data` frame. A page is a window over an ordering the client cannot see, so an insertion before the window shifts every row: there is no patch for it, and a server MUST NOT pretend otherwise by patching only the visible rows. |
| **Authorization changes** | A live query re-executes with the same viewer ([08 §3](08-live-and-sync.md)). If the viewer may no longer read the query, it ends with an `error` frame — the subscription ends, and the client keeps whatever it last held. If the viewer may no longer read one *field* or *entity*, the re-execution produces the answer §06 §3 prescribes for a denial, and the difference reaches the client as an ordinary patch or a fresh `data` frame. Nothing special happens: a denial is a change in the answer. |
| **A patch arrives for a result the client dropped** | Ignored (§3). |
| **The connection drops** | The client reopens the query and receives a fresh `data` frame, which replaces the stored result ([08 §4](08-live-and-sync.md)). It does not receive the patches it missed. |
| **A duplicate patch arrives** | A client cannot detect this in 0.1 and is not asked to. See §4 and §7. |

## 6. What 0.1 guarantees

Plainly, so that nobody has to infer it:

* **Within one response**, frames are ordered, and a client that applies them in order sees exactly the state the
  server described.
* **Across responses**, there is no ordering guarantee. A command's `ok` patch and a live query's `patch` for the
  same entity may arrive in either order, and `set` carries absolute values rather than deltas, so the later arrival
  wins — whichever it is.
* **Eventual re-establishment, not exactly-once delivery.** A client that was away gets the current answer, not the
  changes it missed ([08 §4](08-live-and-sync.md)).

The second of those is the weakest point, and it is honest to say why: with no revision on an entity, a client cannot
tell a newer `set` from an older one, so two patches for one entity racing on different connections settle by arrival
order rather than by which the server produced last. In practice a live query re-executes after the command and the
later patch carries the newer value, so the two converge. The protocol does not currently *guarantee* it.

## 7. Reserved: revisions and resume

Two 0.2 candidates, named here so the shape is fixed and neither is mistaken for something usable.

**Entity revisions.** An entity carrying a monotonic revision would let a client discard a `set` older than what it
holds, which turns §6's ordering caveat from "converges in practice" into a rule. It would also make a duplicate
`list` detectable, which is what §4 needs before any form of replay is safe.

**Resume.** Reconnecting with a cursor and receiving the patches since it, rather than re-running the query. This is
a different guarantee from refetch, not a better implementation of it, and it needs machinery 0.1 does not have:
server-side retention of what it sent, a revision to count from, and a defined answer when the cursor is older than
what the server kept. The order matters — refetch has to be deterministic before resume is worth specifying, or
resume inherits an ambiguity and hides it.

## 8. The invariant a suite can check

Everything above reduces to one property, which is what a conformance suite should assert over generated sequences
of operations rather than over hand-written examples:

```
apply(every patch, in order, to the initial state)  ==  a fresh query of the final server state
```

Read through the shape the client asked for, and subject to §6: the equality holds for the state a client can
observe, not for anything it never selected. A sequence that breaks it has found either a patch a server should not
have sent or an application rule a client got wrong, and the specification is at fault if it did not say which.
