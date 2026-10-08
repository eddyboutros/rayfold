import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Capabilities } from "@rayfold/server";
import { SignJWT } from "jose";
import { RayfoldClient, createFetchTransport, type RayfoldClientError } from "@rayfold/client";
import { devToken } from "./auth.ts";
import { createDocumentStore, documentStoreHttp, scratchDirs, type Bookkeeping } from "./documents.ts";
import { FileStore } from "./files.ts";
import type { Document, Share } from "./resolvers.ts";

/**
 * The whole path, over real HTTP: bytes to the upload route, a command that keeps them, and a GET of the `url` the
 * answer carried. What is asserted throughout is that the bytes are a file and that nothing else ever holds them.
 */
// every upload and every kept document is a file written to disk, which on a busy Windows machine takes up to half a
// second each; a test here makes a dozen, so the runner's 5 s would fail it for the disk's sake, not the code's
vi.setConfig({ testTimeout: 15_000 });

let http: Server;
let base: string;
let dirs: Bookkeeping;
let shop: ReturnType<typeof createDocumentStore>;
/** Ids the store hands out, in order: id1, id2, ... so a test can say what a document and its revisions are called. */
let ids = 0;

/** A clock the tests move, so an expiry is a decision and not a wait. */
const clock = {
  t: 1_700_000_000_000,
  now: () => clock.t,
  set: (v: number) => {
    clock.t = v;
  },
};

beforeEach(async () => {
  clock.set(1_700_000_000_000);
  ids = 0;
  dirs = await scratchDirs();
  shop = createDocumentStore(dirs, { caps: new Capabilities({ secret: "a-test-secret-of-sufficient-length", now: clock.now }), id: () => `id${++ids}`, now: clock.now });
  http = documentStoreHttp(shop);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    http.close(() => resolve());
    http.closeAllConnections();
  });
  await rm(dirname(dirs.files), { recursive: true, force: true });
});

/** Tokens as the identity provider issues them at sign-in; anything else passed as `who` is sent as it is (a share's token). */
const signedIn: Record<string, string> = {};
beforeAll(async () => {
  signedIn["ada"] = await devToken("u1", "Ada");
  signedIn["grace"] = await devToken("u2", "Grace");
});
const bearer = (who: string) => `Bearer ${signedIn[who] ?? who}`;

const client = (who: string) =>
  new RayfoldClient({ transport: createFetchTransport({ url: `${base}/rayfold`, headers: () => ({ authorization: bearer(who) }) }) });

/** Sends bytes to the upload route the way a browser would, and answers with the handle a command will name. */
async function upload(who: string, bytes: Uint8Array, type: string | null = "text/plain"): Promise<string> {
  const res = await fetch(`${base}/rayfold/uploads`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", authorization: bearer(who), ...(type ? { "rayfold-upload-type": type } : {}) },
    body: bytes as BodyInit,
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** Fetches a document's bytes as `who` — a signed-in person, or a share's token. */
const download = (url: string, who?: string) =>
  fetch(`${base}${url}`, who ? { headers: { authorization: bearer(who) } } : undefined);

const text = (s: string) => new TextEncoder().encode(s);
const SHAPE = "{ id name contentType size url version owner { name } }";

it("keeps an uploaded file, answers with its url, and serves the bytes from there", async () => {
  const ada = client("ada");
  const doc = await ada.command<Document>("createDocument", { upload: await upload("ada", text("the first draft")), name: "draft.txt" }, { shape: SHAPE });

  // the revision is named first, then the document
  expect(doc).toEqual({ $type: "Document", id: "id2", name: "draft.txt", contentType: "text/plain", size: 15, url: "/files/id1", version: 1, owner: { $type: "Member", name: "Ada" } });
  expect(shop.store.documents.get("id2")).toMatchObject({ ownerId: "u1", updatedAt: clock.t });

  // the answer carries a url and no bytes; the bytes are one file, and this is where they are served
  expect(JSON.stringify(doc)).not.toContain("the first draft");
  const served = await download(doc.url, "ada");
  expect(served.status).toBe(200);
  expect([served.headers.get("content-type"), served.headers.get("x-content-type-options")]).toEqual(["text/plain", "nosniff"]);
  expect(await served.text()).toBe("the first draft");
  expect(await readdir(dirs.files)).toEqual(["id1"]);
});

it("replaces the bytes, keeps the old revision, and both urls still serve", async () => {
  const ada = client("ada");
  const first = await ada.command<Document>("createDocument", { upload: await upload("ada", text("one")), name: "draft.txt" }, { shape: SHAPE });
  const second = await ada.command<Document>("replaceContent", { id: first.id, upload: await upload("ada", text("two and a half")) }, { shape: SHAPE });

  expect(second).toMatchObject({ id: first.id, version: 2, size: 14 });
  expect(second.url).not.toBe(first.url);
  expect(await (await download(second.url, "ada")).text()).toBe("two and a half");
  // the old revision is still readable: a replace adds, it does not overwrite
  expect(await (await download(first.url, "ada")).text()).toBe("one");

  const history = await ada.query<{ items: Array<{ version: number; size: number; by: { name: string } }> }>(
    "revisions",
    { documentId: first.id },
    { shape: "{ items { version size by { name } } }" },
  );
  expect(history.items).toEqual([
    { $type: "Revision", version: 2, size: 14, by: { $type: "Member", name: "Ada" } },
    { $type: "Revision", version: 1, size: 3, by: { $type: "Member", name: "Ada" } },
  ]);
});

it("refuses a replace that would land on top of someone else's, and leaves no file behind", async () => {
  const ada = client("ada");
  const doc = await ada.command<Document>("createDocument", { upload: await upload("ada", text("one")), name: "draft.txt" }, { shape: SHAPE });
  await ada.command<Document>("replaceContent", { id: doc.id, upload: await upload("ada", text("two")) }, { shape: SHAPE });

  const stale = await upload("ada", text("three"));
  const conflict = await ada
    .command<Document>("replaceContent", { id: doc.id, upload: stale }, { shape: SHAPE, ifVersion: 1 })
    .then(() => null, (e: RayfoldClientError) => e);
  // a conflict is not a domain error: it is failed_precondition, named by its type and carrying both versions
  expect(conflict).toMatchObject({ code: "failed_precondition", type: "VersionConflict" });
  expect(conflict?.data).toMatchObject({ key: `Document:${doc.id}`, expected: 1, actual: 2 });

  // the check happens before the bytes move, so the losing write left nothing: two revisions, not three
  expect(await readdir(dirs.files)).toHaveLength(2);

  // guard: the same write with the version it actually has goes through
  const won = await ada.command<Document>("replaceContent", { id: doc.id, upload: stale }, { shape: SHAPE, ifVersion: 2 });
  expect(won.version).toBe(3);
  expect(await (await download(won.url, "ada")).text()).toBe("three");
});

it("will not let someone else replace or read a document that is not theirs", async () => {
  const doc = await client("ada").command<Document>("createDocument", { upload: await upload("ada", text("private")), name: "draft.txt" }, { shape: SHAPE });

  const refused = await client("grace")
    .command<Document>("replaceContent", { id: doc.id, upload: await upload("grace", text("mine now")) }, { shape: SHAPE })
    .then(() => null, (e: RayfoldClientError) => e);
  expect(refused?.is("Forbidden")).toBe(true);

  // the url is not a permission: knowing it is not enough, for Grace or for nobody at all
  expect((await download(doc.url, "grace")).status).toBe(404);
  expect((await download(doc.url)).status).toBe(401);
  // guard: its owner still reads it
  expect(await (await download(doc.url, "ada")).text()).toBe("private");

  const hers = await client("grace").query<{ items: Document[] }>("documents", {}, { shape: "{ items { id } }" });
  expect(hers.items).toEqual([]);
});

it("takes the bytes with the document when it is deleted", async () => {
  const ada = client("ada");
  const doc = await ada.command<Document>("createDocument", { upload: await upload("ada", text("temporary")), name: "draft.txt" }, { shape: SHAPE });
  expect(await readdir(dirs.files)).toHaveLength(1);

  await ada.command("deleteDocument", { id: doc.id }, { shape: "{ id }" });
  expect(await readdir(dirs.files)).toEqual([]);
  expect((await download(doc.url, "ada")).status).toBe(404);
});

it("says so when the upload a command names has already gone", async () => {
  const ada = client("ada");
  const kept = await upload("ada", text("claimed once"));
  await ada.command<Document>("createDocument", { upload: kept, name: "draft.txt" }, { shape: SHAPE });

  const again = await ada
    .command<Document>("createDocument", { upload: kept, name: "again.txt" }, { shape: SHAPE })
    .then(() => null, (e: RayfoldClientError) => e);
  expect(again?.is("UploadGone")).toBe(true);
  expect(await readdir(dirs.files)).toHaveLength(1);
});

it("leaves the upload directory empty once commands have claimed what arrived", async () => {
  const ada = client("ada");
  await ada.command<Document>("createDocument", { upload: await upload("ada", text("a")), name: "a.txt" }, { shape: SHAPE });
  await ada.command<Document>("createDocument", { upload: await upload("ada", text("b")), name: "b.txt" }, { shape: SHAPE });

  expect(await readdir(dirs.uploads)).toEqual([]);
  expect(await readdir(dirs.files)).toHaveLength(2);
});

it("a share reads that one document and its bytes, and nothing else", async () => {
  const ada = client("ada");
  const doc = await ada.command<Document>("createDocument", { upload: await upload("ada", text("for the lawyer")), name: "contract.txt" }, { shape: SHAPE });
  const other = await ada.command<Document>("createDocument", { upload: await upload("ada", text("not for them")), name: "salaries.txt" }, { shape: SHAPE });

  const share = await ada.command<Share>("shareDocument", { id: doc.id }, { shape: "{ id documentId token ops }" });
  expect(share).toMatchObject({ documentId: doc.id, ops: ["document", "revisions"] });
  expect(share.token).toMatch(/^rfcap1\./);

  // whoever holds the token is not an account here, and has never signed in
  const guest = client(share.token);
  expect(await guest.query<Document>("document", { id: doc.id }, { shape: "{ id name }" })).toMatchObject({ name: "contract.txt" });
  expect(await (await download(doc.url, share.token)).text()).toBe("for the lawyer");

  // the same token, pointed at Ada's other document: the policy on Document refuses it, and a refused entity at a
  // nullable position reads null rather than erroring — the holder cannot even tell it is there
  expect(await guest.query<Document | null>("document", { id: other.id }, { shape: "{ id name }" })).toBeNull();
  expect((await download(other.url, share.token)).status).toBe(404);
});

it("a share cannot change anything, whatever it is asked to run", async () => {
  const ada = client("ada");
  const doc = await ada.command<Document>("createDocument", { upload: await upload("ada", text("read only")), name: "contract.txt" }, { shape: SHAPE });
  const share = await ada.command<Share>("shareDocument", { id: doc.id }, { shape: "{ token }" });
  const guest = client(share.token);

  for (const [op, args] of [
    ["renameDocument", { id: doc.id, name: "mine now" }],
    ["deleteDocument", { id: doc.id }],
    ["shareDocument", { id: doc.id }],
  ] as const) {
    const refused = await guest.command(op, args, { shape: "{ id }" }).then(() => null, (e: RayfoldClientError) => e);
    expect(refused?.code, op).toBe("permission_denied");
  }

  // nothing moved: the document is as its owner left it
  expect(await ada.query<Document>("document", { id: doc.id }, { shape: "{ name version }" })).toMatchObject({ name: "contract.txt", version: 1 });

  // guard: the refusal is the share's, not the command's: its owner renames it, and the new name is what is read back
  expect(await ada.command<Document>("renameDocument", { id: doc.id, name: "signed.txt" }, { shape: "{ id name version }" })).toMatchObject({ id: doc.id, name: "signed.txt", version: 2 });
  expect(await ada.query<Document>("document", { id: doc.id }, { shape: "{ name version }", policy: "network" })).toMatchObject({ name: "signed.txt", version: 2 });
});

it("a share stops working when it expires", async () => {
  const ada = client("ada");
  const doc = await ada.command<Document>("createDocument", { upload: await upload("ada", text("briefly")), name: "contract.txt" }, { shape: SHAPE });
  const share = await ada.command<Share>("shareDocument", { id: doc.id, ttlMs: 1000 }, { shape: "{ token expiresAt }" });

  // guard: it works while it lives, so what follows is expiry and not a token that never worked
  expect(await client(share.token).query<Document>("document", { id: doc.id }, { shape: "{ id }" })).toMatchObject({ id: doc.id });

  clock.set(clock.now() + 1001);
  const stale = await client(share.token).query<Document>("document", { id: doc.id }, { shape: "{ id }" }).then(() => null, (e: RayfoldClientError) => e);
  expect(stale?.code).toBe("unauthenticated");
  expect((await download(doc.url, share.token)).status).toBe(401);
});

it("a share is refused for a document that is not yours", async () => {
  const doc = await client("ada").command<Document>("createDocument", { upload: await upload("ada", text("private")), name: "contract.txt" }, { shape: SHAPE });

  const refused = await client("grace").command<Share>("shareDocument", { id: doc.id }, { shape: "{ token }" }).then(() => null, (e: RayfoldClientError) => e);
  expect(refused?.is("Forbidden")).toBe(true);
});

it("believes who is signed in only from a token that verifies: a bare name is refused, and the file stays unread", async () => {
  const doc = await client("ada").command<Document>("createDocument", { upload: await upload("ada", text("mine")), name: "mine.txt" }, { shape: SHAPE });
  const asName = await fetch(`${base}/rayfold`, {
    method: "POST",
    headers: { "content-type": "application/rayfold+json", authorization: "Bearer ada" },
    body: JSON.stringify({ ops: [{ id: 1, op: "documents", args: {}, shape: "{ items { id } }" }] }),
  });
  expect(asName.status).toBe(401);
  expect(((await asName.json()) as { detail: string }).detail).toBe("Invalid or expired token");
  expect((await download(doc.url, "Bearer-free-name")).status).toBe(401);
  // guard: the same person with a token the server signed reads it
  expect(await (await download(doc.url, "ada")).text()).toBe("mine");
});

it("a document kept without a type is octet-stream, and a replace takes the new bytes' type; guard: one without a type keeps the old", async () => {
  const ada = client("ada");
  const doc = await ada.command<Document>("createDocument", { upload: await upload("ada", text("{}"), null), name: "data" }, { shape: SHAPE });
  expect(doc.contentType).toBe("application/octet-stream");
  clock.set(clock.t + 5000);
  const json = await ada.command<Document>("replaceContent", { id: doc.id, upload: await upload("ada", text("[]"), "application/json") }, { shape: SHAPE });
  expect(json).toMatchObject({ contentType: "application/json", url: "/files/id3", version: 2, size: 2 });
  expect(shop.store.documents.get(doc.id)!.updatedAt).toBe(clock.t);
  expect((await download(json.url, "ada")).headers.get("content-type")).toBe("application/json");
  const untyped = await ada.command<Document>("replaceContent", { id: doc.id, upload: await upload("ada", text("[1]"), null) }, { shape: SHAPE });
  expect(untyped).toMatchObject({ contentType: "application/json", version: 3 });
});

it("each document's revisions are its own, by whoever wrote them; a deleted document leaves none behind", async () => {
  const ada = client("ada");
  const grace = client("grace");
  const one = await ada.command<Document>("createDocument", { upload: await upload("ada", text("a")), name: "a.txt" }, { shape: SHAPE });
  const hers = await grace.command<Document>("createDocument", { upload: await upload("grace", text("g")), name: "g.txt" }, { shape: SHAPE });
  await grace.command("replaceContent", { id: hers.id, upload: await upload("grace", text("gg")) }, { shape: "{ id }" });
  const shape = { shape: "{ items { id version by { name } } }" };
  expect(await ada.query("revisions", { documentId: one.id }, shape)).toEqual({ items: [{ $type: "Revision", id: "id1", version: 1, by: { $type: "Member", name: "Ada" } }] });
  expect(await grace.query("revisions", { documentId: hers.id }, shape)).toEqual({
    items: [
      { $type: "Revision", id: "id5", version: 2, by: { $type: "Member", name: "Grace" } },
      { $type: "Revision", id: "id3", version: 1, by: { $type: "Member", name: "Grace" } },
    ],
  });

  await grace.command("deleteDocument", { id: hers.id }, { shape: "{ id }" });
  expect(await grace.query("revisions", { documentId: hers.id }, shape)).toEqual({ items: [] });
  expect([...shop.store.revisions.keys()]).toEqual(["id1"]);
  // guard: Ada's document and its revision are untouched
  expect(await (await download(one.url, "ada")).text()).toBe("a");
});

it("pages through someone's documents by cursor", async () => {
  const ada = client("ada");
  for (const name of ["1.txt", "2.txt", "3.txt"]) await ada.command("createDocument", { upload: await upload("ada", text(name)), name }, { shape: "{ id }" });
  type P = { items: Array<{ name: string }>; cursor: string | null; hasMore: boolean; total: number };
  const shape = { shape: "{ items { name } cursor hasMore total }" };
  const first = await ada.query<P>("documents", { page: { first: 2 } }, shape);
  expect(first).toEqual({ items: [{ $type: "Document", name: "1.txt" }, { $type: "Document", name: "2.txt" }], cursor: "id4", hasMore: true, total: 3 });
  expect(await ada.query<P>("documents", { page: { first: 2, after: first.cursor } }, shape)).toEqual({ items: [{ $type: "Document", name: "3.txt" }], cursor: "id6", hasMore: false, total: 3 });
  expect(await ada.query<P>("documents", { page: { first: 1, after: "id4" } }, shape)).toEqual({ items: [{ $type: "Document", name: "3.txt" }], cursor: "id6", hasMore: false, total: 3 });
});

it("renames against the version read, and a dry run renames nothing", async () => {
  const ada = client("ada");
  const doc = await ada.command<Document>("createDocument", { upload: await upload("ada", text("x")), name: "draft.txt" }, { shape: SHAPE });
  const dry = await ada.command<Document>("renameDocument", { id: doc.id, name: "final.txt" }, { shape: "{ name version }", simulate: true });
  expect(dry).toEqual({ $type: "Document", name: "final.txt", version: 2 });
  expect(shop.store.documents.get(doc.id)).toMatchObject({ name: "draft.txt", version: 1 });

  clock.set(clock.t + 60_000);
  expect(await ada.command("renameDocument", { id: doc.id, name: "final.txt" }, { shape: "{ name version }", ifVersion: 1 })).toEqual({ $type: "Document", name: "final.txt", version: 2 });
  expect(shop.store.documents.get(doc.id)!.updatedAt).toBe(clock.t);
  const stale = await ada.command("renameDocument", { id: doc.id, name: "lost.txt" }, { ifVersion: 1 }).then(() => null, (e: RayfoldClientError) => e);
  expect([stale?.type, stale?.data]).toMatchObject(["VersionConflict", { key: `Document:${doc.id}`, expected: 1, actual: 2 }]);
  expect(shop.store.documents.get(doc.id)!.name).toBe("final.txt");

  const missing = await ada.command("renameDocument", { id: "nope", name: "x" }).then(() => null, (e: RayfoldClientError) => e);
  expect([missing?.type, missing?.data]).toEqual(["NotFound", { id: "nope" }]);
});

it("announces every change to a document with its new version, and nothing for one refused", async () => {
  const changes: unknown[] = [];
  const off = shop.server.events.on("DocumentChanged", (e) => changes.push(e));
  const ada = client("ada");
  const doc = await ada.command<Document>("createDocument", { upload: await upload("ada", text("1")), name: "a.txt" }, { shape: SHAPE });
  await ada.command("replaceContent", { id: doc.id, upload: await upload("ada", text("2")) }, { shape: "{ id }" });
  await client("grace").command("renameDocument", { id: doc.id, name: "theirs" }).catch(() => undefined);
  await ada.command("renameDocument", { id: doc.id, name: "b.txt" }, { shape: "{ id }" });
  off();
  expect(changes).toEqual([
    { documentId: doc.id, version: 1, seq: 1 },
    { documentId: doc.id, version: 2, seq: 2 },
    { documentId: doc.id, version: 3, seq: 3 },
  ]);
});

it("refuses to delete someone else's document, or to replace one that is not there", async () => {
  const doc = await client("ada").command<Document>("createDocument", { upload: await upload("ada", text("keep")), name: "keep.txt" }, { shape: SHAPE });
  const refused = await client("grace").command("deleteDocument", { id: doc.id }).then(() => null, (e: RayfoldClientError) => e);
  expect([refused?.type, refused?.data]).toEqual(["Forbidden", { id: doc.id }]);
  const missing = await client("grace").command("replaceContent", { id: "nope", upload: await upload("grace", text("x")) }).then(() => null, (e: RayfoldClientError) => e);
  expect([missing?.type, missing?.data]).toEqual(["NotFound", { id: "nope" }]);
  expect(await readdir(dirs.files)).toEqual(["id1"]);
  expect(await (await download(doc.url, "ada")).text()).toBe("keep");
});

it("a share says when it expires, by the store's clock", async () => {
  const doc = await client("ada").command<Document>("createDocument", { upload: await upload("ada", text("x")), name: "x.txt" }, { shape: SHAPE });
  const share = await client("ada").command<Share>("shareDocument", { id: doc.id, ttlMs: 90_000 }, { shape: "{ id documentId expiresAt ops }" });
  expect(share).toEqual({ $type: "Share", id: "id3", documentId: doc.id, expiresAt: clock.t + 90_000, ops: ["document", "revisions"] });
});

it("a share's token works in the url too, for an <img> or a link that cannot send a header", async () => {
  const ada = client("ada");
  const doc = await ada.command<Document>("createDocument", { upload: await upload("ada", text("linked")), name: "l.txt" }, { shape: SHAPE });
  const { token } = await ada.command<Share>("shareDocument", { id: doc.id }, { shape: "{ token }" });
  const linked = await fetch(`${base}${doc.url}?token=${encodeURIComponent(token)}`);
  expect([linked.status, await linked.text()]).toEqual([200, "linked"]);
  // guard: the url alone, or with a token that is not a share's, is refused
  expect((await fetch(`${base}${doc.url}?token=nope`)).status).toBe(401);
  expect((await fetch(`${base}${doc.url}`)).status).toBe(401);
});

it("a share's token that does not verify is nobody: its calls are answered as anyone's would be, not refused outright", async () => {
  const ada = client("ada");
  const doc = await ada.command<Document>("createDocument", { upload: await upload("ada", text("x")), name: "x.txt" }, { shape: SHAPE });
  const { token } = await ada.command<Share>("shareDocument", { id: doc.id }, { shape: "{ token }" });
  const forged = token.slice(0, -4) + (token.endsWith("AAAA") ? "BBBB" : "AAAA");
  const res = await fetch(`${base}/rayfold`, {
    method: "POST",
    headers: { "content-type": "application/rayfold+json", authorization: `Bearer ${forged}` },
    body: JSON.stringify({ ops: [{ id: 1, op: "document", args: { id: doc.id }, shape: "{ id }" }] }),
  });
  expect(res.status).toBe(200);
  expect((await res.text()).trim().split("\n").map((l) => JSON.parse(l) as { error?: { code: string } })[0]!.error?.code).toBe("unauthenticated");
  expect((await download(doc.url, forged)).status).toBe(401);
  // a token shaped like neither a share nor a sign-in is a bad sign-in token
  const odd = await fetch(`${base}/rayfold`, { method: "POST", headers: { "content-type": "application/rayfold+json", authorization: "Bearer rfcapnot.a.share" }, body: JSON.stringify({ ops: [] }) });
  expect([odd.status, ((await odd.json()) as { detail: string }).detail]).toEqual([401, "Invalid or expired token"]);
});

it("serves the bytes only to a GET, and not at all once the file has gone", async () => {
  const doc = await client("ada").command<Document>("createDocument", { upload: await upload("ada", text("x")), name: "x.txt" }, { shape: SHAPE });
  expect((await fetch(`${base}${doc.url}`, { method: "POST", headers: { authorization: bearer("ada") } })).status).toBe(404);
  expect((await fetch(`${base}/elsewhere`)).status).toBe(404);
  await rm(join(dirs.files, "id1"));
  expect((await download(doc.url, "ada")).status).toBe(404);
});

it("a file that fails part-way through serving ends the response instead of passing for the whole file", async () => {
  await new Promise<void>((resolve) => {
    http.close(() => resolve());
    http.closeAllConnections();
  });
  class Failing extends FileStore {
    override read(): ReadableStream<Uint8Array> {
      return new ReadableStream({
        pull(c) {
          c.enqueue(new TextEncoder().encode("the first half"));
          c.error(new Error("the disk went away"));
        },
      });
    }
  }
  shop = createDocumentStore(dirs, { files: new Failing(dirs.files), id: () => `id${++ids}`, now: clock.now });
  http = documentStoreHttp(shop);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const doc = await client("ada").command<Document>("createDocument", { upload: await upload("ada", text("whole")), name: "x.txt" }, { shape: SHAPE });
  // the status line may or may not have gone out first; either way the client is told the bytes are not whole
  await expect(download(doc.url, "ada").then((res) => res.text())).rejects.toThrow();
});

it("believes a signed-in caller only from a token for this audience and issuer, sent as a bearer", async () => {
  const doc = await client("ada").command<Document>("createDocument", { upload: await upload("ada", text("mine")), name: "mine.txt" }, { shape: SHAPE });
  const signed = (claims: { iss?: string; aud?: string }) =>
    new SignJWT({ name: "Ada" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("u1")
      .setIssuer(claims.iss ?? "http://localhost:4400/dev")
      .setAudience(claims.aud ?? "documents")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("document store development key, not a secret"));
  const documents = (authorization: string) =>
    fetch(`${base}/rayfold`, { method: "POST", headers: { "content-type": "application/rayfold+json", authorization }, body: JSON.stringify({ ops: [{ id: 1, op: "documents", args: {}, shape: "{ total }" }] }) });
  for (const [authorization, detail] of [
    [`Bearer ${await signed({ aud: "bookshop" })}`, "Invalid or expired token"],
    [`Bearer ${await signed({ iss: "https://someone-else.example" })}`, "Invalid or expired token"],
    [`Token ${signedIn["ada"]}`, "Expected Authorization: Bearer <token>"],
  ] as const) {
    const res = await documents(authorization);
    expect([res.status, ((await res.json()) as { detail: string }).detail]).toEqual([401, detail]);
  }
  // guard: the same claims for this audience and issuer are believed
  expect((await documents(`Bearer ${await signed({})}`)).status).toBe(200);
  expect(await (await download(doc.url, await signed({}))).text()).toBe("mine");
});

describe("the file store on its own", () => {
  let dir: string;
  beforeEach(async () => {
    dir = join(dirname(dirs.files), "store");
    await mkdir(dirname(dirs.files), { recursive: true });
    await writeFile(join(dirname(dirs.files), "secret"), "outside");
  });
  const body = (s: string) => new Blob([s]).stream() as ReadableStream<Uint8Array>;

  it("writes, reads, answers has and removes by name", async () => {
    const files = new FileStore(dir, "https://cdn.example");
    expect(await files.write("r-1_A", body("bytes"))).toBe(5);
    expect(files.url("r-1_A")).toBe("https://cdn.example/r-1_A");
    expect(await new Response(files.read("r-1_A")).text()).toBe("bytes");
    expect([await files.has("r-1_A"), await files.has("r-2")]).toEqual([true, false]);
    await files.remove("r-1_A");
    expect([await files.has("r-1_A"), await readdir(dir)]).toEqual([false, []]);
  });

  it("no name reaches outside its directory: a path is refused, read as nothing, and removes nothing", async () => {
    const files = new FileStore(dir);
    for (const id of ["../secret", "..", "a/b", "", "x".repeat(129)]) {
      await expect(files.write(id, body("evil")), id).rejects.toThrow("is not a usable name");
      expect(files.read(id), id).toBeUndefined();
      expect(await files.has(id), id).toBe(false);
      await files.remove(id);
    }
    expect(await readFile(join(dirname(dirs.files), "secret"), "utf8")).toBe("outside");
    expect(await readdir(dir).catch(() => [])).toEqual([]);
  });

  it("a write that fails part-way leaves no file behind", async () => {
    const files = new FileStore(dir);
    const failing = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new TextEncoder().encode("half"));
        c.error(new Error("the upload was cut"));
      },
    });
    await expect(files.write("cut", failing)).rejects.toThrow("the upload was cut");
    expect(await files.has("cut")).toBe(false);
    expect(await readdir(dir)).toEqual([]);
  });
});
