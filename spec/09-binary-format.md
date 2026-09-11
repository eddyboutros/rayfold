# 09 — Binary format RB (extension `rb`)

RB carries exactly the JSON model of spec 04 in fewer bytes. Nothing changes semantically: a server that
accepts RB MUST produce the same frames it would produce in JSON, and a client MAY switch between the two
per request. Content type `application/rayfold`; JSON is `application/rayfold+json` / `application/rayfold-frames+json`.

## 1. Framing

A message is a sequence of frames, each prefixed by its byte length as an unsigned LEB128 varint. Decoders
consume frames as soon as their bytes are complete, so chunked HTTP responses and WebSocket binary
messages stream naturally. A zero-length frame carries no value: it is a keep-alive ([04 §4](04-frames-and-transport.md))
and decoders skip it.

## 2. Values

One tag byte, then payload:

| Tag | Value |
|---|---|
| `0x00` | null |
| `0x01` / `0x02` | false / true |
| `0x03` + zigzag varint | integer (up to ±2^53) |
| `0x04` + 8 bytes | IEEE 754 double, little-endian (only for non-integers) |
| `0x05` + varint length + UTF-8 | string; appended to the per-message **string table** |
| `0x06` + varint index | reference to an earlier string in this message |
| `0x07` + varint count + values | list |
| `0x08` + varint count + (key, value)* | object |
| `0x09` + varint length + bytes | bytes (`Bytes` scalar) |
| `0x80`–`0xFF` | small integer 0–127 inline |

Object keys are a varint `k`: even `k` is a **dictionary id** `k/2`; odd `k` is an inline UTF-8 key of
length `(k-1)/2`. Undefined members are omitted, as in JSON.

## 3. Key dictionary

Ids 0–37 are the protocol keys (`id`, `op`, `args`, `shape`, `vars`, `key`, `live`, `deadline`, `simulate`,
`ops`, `meta`, `rayfold`, `data`, `ok`, `item`, `patch`, `at`, `error`, `fin`, `errors`, `code`, `type`,
`message`, `path`, `retryable`, `set`, `value`, `del`, `inv`, `invOp`, `cost`, `cache`, `$type`, `$ref`,
`client`, `replay`, `cursor`, `ms`), in that order. After them come every field name, argument name, enum
value and operation name of the schema, deduplicated and **sorted**, so both sides derive the identical
table from the IR. A client learns the schema hash from `Rayfold-Schema` / the manifest; on a hash mismatch it
MUST fall back to JSON for that request.

Field ordinals from `rayfold.lock.json` are reserved for a future compact-struct encoding; the dictionary
approach was chosen for 0.1 because it keeps unknown keys (extensions, `JSON` scalars, `$vendor` metadata)
representable without a schema round trip.

## 4. Negotiation

* HTTP request body: `Content-Type: application/rayfold` (the envelope as one RB value).
* HTTP response: `Accept: application/rayfold` → `Content-Type: application/rayfold`, length-prefixed frames.
* WebSocket: binary messages are RB; text messages are JSON. A connection MAY mix both.

## 5. Compression

Optional and orthogonal: `Content-Encoding: zstd` or `br`; with RFC 9842 dictionary transport a server MAY
advertise a schema-derived dictionary. Neither changes the RB byte stream.

## 6. Measured

`rayfold bench` reports bytes for the same responses in JSON and RB; see [`bench/results/`](../bench/results/).
