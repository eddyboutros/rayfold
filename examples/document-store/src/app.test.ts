import { afterEach, beforeEach, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Capabilities } from "@rayfold/server";
import { RayfoldClient, createFetchTransport, type RayfoldClientError } from "@rayfold/client";
import { createDocumentStore, documentStoreHttp, scratchDirs, type Bookkeeping } from "./documents.ts";
import type { Document, Share } from "./resolvers.ts";

/**
 * The whole path, over real HTTP: bytes to the upload route, a command that keeps them, and a GET of the `url` the
 * answer carried. What is asserted throughout is that the bytes are a file and that nothing else ever holds them.
 */
let http: Server;
let base: string;
let dirs: Bookkeeping;
let shop: ReturnType<typeof createDocumentStore>;

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
  dirs = await scratchDirs();
  shop = createDocumentStore(dirs, { caps: new Capabilities({ secret: "a-test-secret-of-sufficient-length", now: clock.now }) });
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

const client = (who: string) =>
  new RayfoldClient({ transport: createFetchTransport({ url: `${base}/rayfold`, headers: () => ({ authorization: `Bearer ${who}` }) }) });

/** Sends bytes to the upload route the way a browser would, and answers with the handle a command will name. */
async function upload(who: string, bytes: Uint8Array, type = "text/plain"): Promise<string> {
  const res = await fetch(`${base}/rayfold/uploads`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", authorization: `Bearer ${who}`, "rayfold-upload-type": type },
    body: bytes as BodyInit,
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** Fetches a document's bytes as `who` — a signed-in person, or a share's token. */
const download = (url: string, who?: string) =>
  fetch(`${base}${url}`, who ? { headers: { authorization: `Bearer ${who}` } } : undefined);

const text = (s: string) => new TextEncoder().encode(s);
const SHAPE = "{ id name contentType size url version owner { name } }";

it("keeps an uploaded file, answers with its url, and serves the bytes from there", async () => {
  const ada = client("ada");
  const doc = await ada.command<Document>("createDocument", { upload: await upload("ada", text("the first draft")), name: "draft.txt" }, { shape: SHAPE });

  expect(doc).toMatchObject({ name: "draft.txt", contentType: "text/plain", size: 15, version: 1, owner: { name: "Ada" } });
  expect(doc.url).toMatch(/^\/files\/[0-9a-f-]{8,}$/);

  // the answer carries a url and no bytes; the bytes are one file, and this is where they are served
  expect(JSON.stringify(doc)).not.toContain("the first draft");
  const served = await download(doc.url, "ada");
  expect(served.status).toBe(200);
  expect(await served.text()).toBe("the first draft");
  expect(await readdir(dirs.files)).toHaveLength(1);
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
