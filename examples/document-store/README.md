# Document store

Upload a file, replace it, keep every revision — and never put the bytes anywhere except on disk.

```sh
npm run server -w @rayfold/example-document-store
```

Three routes, and only one of them carries bytes:

| Route | What travels |
|---|---|
| `POST /rayfold/uploads` | the bytes, once, streamed straight to a file |
| `POST /rayfold` | a command naming the upload; the answer carries `url`, never the bytes |
| `GET /files/{id}` | where that `url` points |

Who is calling comes from a signed token (a JWT), checked the way the bookshop examples check theirs: with no
identity provider configured, the server signs and checks tokens with a development key. This prints Ada's, and
`-- grace` Grace's:

```sh
npm run -s token -w @rayfold/example-document-store
```

In production, `AUTH_JWKS_URL` and `AUTH_ISSUER` name your identity provider, and the development key is never used.

## Why it is shaped this way

A batch is JSON, so a file in one would have to be base64: a third larger, held whole at both ends, and mixed in
with everything else the batch is doing. So the bytes arrive on their own route, `FileUploadStore` streams them to a
file, and the command that claims them moves that file into the store's own directory under a revision id. What the
command answers with is a `Document` carrying `url` — the same string an `<img>`, a download link or another service
would use, and the only way anything here refers to the bytes.

An upload is a staging area with a lifetime. A document is not. That is the whole reason the two stores are
different things: whatever nobody claims is swept, and what a command kept stays until the document is deleted.

In production `FileStore` is an object store and `url` points at it or at a CDN in front of it. Nothing else in the
schema or the resolvers changes.

## Sharing, without an account

`shareDocument` mints a **capability token**: a short-lived, signed reference to a viewer that exists only to read
one document. Nothing is stored — the token carries who it speaks for, the operations it may call and when it
expires, and it is signed, so verifying it needs no lookup.

```ts
const share = await client.command("shareDocument", { id: doc.id, ttlMs: 3_600_000 });
// share.token -> "rfcap1.…", good for `document` and `revisions`, for this document, for an hour
```

Two rules do the work, and neither is an `if` in a resolver:

- **the schema.** `Document` carries `@allow(read: viewer.id == ownerId || viewer.documentId == id)`. The viewer a
  token speaks for has a `documentId` and no account, so it satisfies the second half for exactly one document.
  Asking for another reads `null` — a refused entity at a nullable position is not there rather than forbidden, so
  the holder cannot even learn it exists.
- **the token.** It names `["document", "revisions"]`, and the batch refuses anything else before a resolver runs.
  It cannot be widened: attenuation only ever narrows.

The bytes are covered by the same rule. `GET /files/{id}` looks up which document a revision belongs to and applies
it, so an unguessable URL is not a permission. A browser following a share link cannot set a header, so the token
is accepted as `?token=` too — the trade-off signed URLs make everywhere: it is visible in logs and referrers, which
is what the short lifetime is for.

## What it exercises

The upload extension end to end, **capability tokens** for sharing, `@version` conditional writes (`ifVersion`, and
the `VersionConflict` that comes back carrying both versions so a client can repair without a refetch), entity-level
policies, declared errors by name, loaders for `owner` and `by`, and per-viewer reads.

`src/app.test.ts` drives all of it over real HTTP with the real client.
