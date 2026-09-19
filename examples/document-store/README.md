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

## What it exercises

The upload extension end to end, `@version` conditional writes (`ifVersion`, and the `VersionConflict` that comes
back carrying both versions so a client can repair without a refetch), declared errors by name, loaders for
`owner` and `by`, and per-viewer reads.

`src/app.test.ts` drives all of it over real HTTP with the real client.
