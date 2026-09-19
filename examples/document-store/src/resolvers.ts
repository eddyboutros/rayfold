/**
 * The document store's data and resolvers.
 *
 * The rule the whole example exists to show: a command never holds a file. It moves the upload's bytes into the
 * file store, keeps the size and the URL, and answers with a document that carries neither the bytes nor a path —
 * only `url`.
 */
import { RayfoldError, ok, type Resolvers } from "@rayfold/server/core";
import type { Capabilities, UploadStore } from "@rayfold/server";
import type { FileStore } from "./files.ts";

export interface Member {
  id: string;
  name: string;
}

export interface Document {
  id: string;
  name: string;
  contentType: string;
  size: number;
  url: string;
  version: number;
  updatedAt: number;
  ownerId: string;
}

export interface Revision {
  id: string;
  documentId: string;
  version: number;
  size: number;
  url: string;
  at: number;
  byId: string;
}

export interface Viewer {
  id: string;
  name?: string;
  /** Set only on the viewer a share's token speaks for: the one document it may read. */
  documentId?: string;
}

/** What a share hands out. Nothing is stored: the token carries its own permission and expiry. */
export interface Share {
  id: string;
  documentId: string;
  token: string;
  expiresAt: number;
  ops: string[];
}

/** The operations a share's holder may call. Reading only: a share is a link, not an account. */
export const SHARED_OPS = ["document", "revisions"];

export function seed() {
  return {
    members: new Map<string, Member>([
      ["u1", { id: "u1", name: "Ada" }],
      ["u2", { id: "u2", name: "Grace" }],
    ]),
    documents: new Map<string, Document>(),
    revisions: new Map<string, Revision>(),
  };
}
export type Store = ReturnType<typeof seed>;

export interface Parts {
  store: Store;
  files: FileStore;
  uploads: UploadStore;
  /** Signs the tokens `shareDocument` hands out. */
  caps: Capabilities;
  /** Ids, injectable so a test can say what a document and its revisions are called. */
  id?: () => string;
  /** Wall clock, injectable for the same reason. */
  now?: () => number;
}

// #region resolvers
export function resolvers({ store, files, uploads, caps, id = () => crypto.randomUUID(), now = Date.now }: Parts): Resolvers {
  const find = (documentId: string) => {
    const doc = store.documents.get(documentId);
    if (!doc) throw RayfoldError.domain("NotFound", { id: documentId }, `No document ${documentId}`);
    return doc;
  };

  const mine = (doc: Document, viewer: Viewer) => {
    if (doc.ownerId !== viewer.id) throw RayfoldError.domain("Forbidden", { id: doc.id }, `${doc.name} is not yours`);
    return doc;
  };

  // #region move
  /** Moves an upload's bytes into the file store under a fresh revision id. The upload is gone afterwards. */
  const keep = async (upload: string): Promise<{ revisionId: string; size: number; name?: string | undefined; type?: string | undefined }> => {
    const kept = await uploads.open(upload);
    if (!kept) throw RayfoldError.domain("UploadGone", { upload }, `Upload ${upload} is not there any more`);
    const revisionId = id();
    const size = await files.write(revisionId, kept.body);
    await uploads.delete(upload);
    return { revisionId, size, name: kept.upload.name, type: kept.upload.type };
  };
  // #endregion move

  const page = <T extends { id: string }>(all: T[], p: { first: number; after?: string | null }) => {
    const start = p.after ? all.findIndex((x) => x.id === p.after) + 1 : 0;
    const items = all.slice(start, start + p.first);
    return { items, total: all.length, hasMore: start + items.length < all.length, cursor: items.at(-1)?.id ?? null };
  };

  return {
    Query: {
      document: ({ id: documentId }: { id: string }) => store.documents.get(documentId) ?? null,
      documents: ({ page: p }: { page: { first: number; after?: string | null } }, ctx) =>
        page(
          [...store.documents.values()].filter((d) => d.ownerId === (ctx.viewer as Viewer).id),
          p,
        ),
      revisions: ({ documentId, page: p }: { documentId: string; page: { first: number; after?: string | null } }) =>
        page(
          [...store.revisions.values()].filter((r) => r.documentId === documentId).sort((a, b) => b.version - a.version),
          p,
        ),
    },

    Command: {
      // #region create
      createDocument: async ({ upload, name }: { upload: string; name: string }, ctx) => {
        const viewer = ctx.viewer as Viewer;
        const { revisionId, size, type } = await keep(upload);
        const doc: Document = {
          id: id(),
          name,
          contentType: type ?? "application/octet-stream",
          size,
          url: files.url(revisionId),
          version: 1,
          updatedAt: now(),
          ownerId: viewer.id,
        };
        store.documents.set(doc.id, doc);
        store.revisions.set(revisionId, { id: revisionId, documentId: doc.id, version: 1, size, url: doc.url, at: doc.updatedAt, byId: viewer.id });
        return ok(doc, { emit: [{ event: "DocumentChanged", payload: { documentId: doc.id, version: 1 } }] });
      },
      // #endregion create

      // #region replace
      replaceContent: async ({ id: documentId, upload }: { id: string; upload: string }, ctx) => {
        const viewer = ctx.viewer as Viewer;
        const doc = mine(find(documentId), viewer);
        // before the bytes move: a replace that would land on top of someone else's is refused here, so a losing
        // write never leaves a file behind
        ctx.checkVersion(`Document:${doc.id}`, doc.version, doc);
        const { revisionId, size, type } = await keep(upload);
        doc.version += 1;
        doc.size = size;
        doc.url = files.url(revisionId);
        doc.contentType = type ?? doc.contentType;
        doc.updatedAt = now();
        store.revisions.set(revisionId, { id: revisionId, documentId: doc.id, version: doc.version, size, url: doc.url, at: doc.updatedAt, byId: viewer.id });
        return ok(doc, { emit: [{ event: "DocumentChanged", payload: { documentId: doc.id, version: doc.version } }] });
      },
      // #endregion replace

      renameDocument: ({ id: documentId, name }: { id: string; name: string }, ctx) => {
        const doc = mine(find(documentId), ctx.viewer as Viewer);
        ctx.checkVersion(`Document:${doc.id}`, doc.version, doc);
        if (ctx.simulate) return ok({ ...doc, name, version: doc.version + 1 });
        doc.name = name;
        doc.version += 1;
        doc.updatedAt = now();
        return ok(doc, { emit: [{ event: "DocumentChanged", payload: { documentId: doc.id, version: doc.version } }] });
      },

      // #region share
      shareDocument: ({ id: documentId, ttlMs }: { id: string; ttlMs: number }, ctx) => {
        const doc = mine(find(documentId), ctx.viewer as Viewer);
        // the viewer the token speaks for is not an account: it exists only to satisfy the policy on Document,
        // which reads viewer.documentId. so a share cannot be turned into a way to read anything else.
        const token = caps.mint({ id: `share:${doc.id}`, documentId: doc.id }, { ops: SHARED_OPS, ttlMs, iss: "document-store" });
        return ok({ id: id(), documentId: doc.id, token, expiresAt: now() + ttlMs, ops: SHARED_OPS });
      },
      // #endregion share

      deleteDocument: async ({ id: documentId }: { id: string }, ctx) => {
        const doc = mine(find(documentId), ctx.viewer as Viewer);
        const revisions = [...store.revisions.values()].filter((r) => r.documentId === doc.id);
        store.documents.delete(doc.id);
        for (const r of revisions) {
          store.revisions.delete(r.id);
          await files.remove(r.id); // the bytes go with the document; nothing else refers to them
        }
        return ok(doc);
      },
    },

    Document: {
      owner: (docs: Document[]) => docs.map((d) => store.members.get(d.ownerId) ?? null),
    },

    Revision: {
      by: (revisions: Revision[]) => revisions.map((r) => store.members.get(r.byId) ?? null),
    },
  };
}
// #endregion resolvers

/** Stands in for real authentication: check your session cookie or JWT here instead. */
export function viewerFrom(authorization: string | undefined): Viewer | null {
  if (authorization === "Bearer ada") return { id: "u1", name: "Ada" };
  if (authorization === "Bearer grace") return { id: "u2", name: "Grace" };
  return null;
}
