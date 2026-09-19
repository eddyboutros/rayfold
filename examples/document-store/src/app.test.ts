import { afterEach, beforeEach, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { RayfoldClient, createFetchTransport, type RayfoldClientError } from "@rayfold/client";
import { createDocumentStore, documentStoreHttp, scratchDirs, type Bookkeeping } from "./documents.ts";
import type { Document } from "./resolvers.ts";

/**
 * The whole path, over real HTTP: bytes to the upload route, a command that keeps them, and a GET of the `url` the
 * answer carried. What is asserted throughout is that the bytes are a file and that nothing else ever holds them.
 */
let http: Server;
let base: string;
let dirs: Bookkeeping;
let shop: ReturnType<typeof createDocumentStore>;

beforeEach(async () => {
  dirs = await scratchDirs();
  shop = createDocumentStore(dirs);
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

const text = (s: string) => new TextEncoder().encode(s);
const SHAPE = "{ id name contentType size url version owner { name } }";

it("keeps an uploaded file, answers with its url, and serves the bytes from there", async () => {
  const ada = client("ada");
  const doc = await ada.command<Document>("createDocument", { upload: await upload("ada", text("the first draft")), name: "draft.txt" }, { shape: SHAPE });

  expect(doc).toMatchObject({ name: "draft.txt", contentType: "text/plain", size: 15, version: 1, owner: { name: "Ada" } });
  expect(doc.url).toMatch(/^\/files\/[0-9a-f-]{8,}$/);

  // the answer carries a url and no bytes; the bytes are one file, and this is where they are served
  expect(JSON.stringify(doc)).not.toContain("the first draft");
  const served = await fetch(`${base}${doc.url}`);
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
  expect(await (await fetch(`${base}${second.url}`)).text()).toBe("two and a half");
  // the old revision is still readable: a replace adds, it does not overwrite
  expect(await (await fetch(`${base}${first.url}`)).text()).toBe("one");

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
  expect(await (await fetch(`${base}${won.url}`)).text()).toBe("three");
});

it("will not let someone else replace or read a document that is not theirs", async () => {
  const doc = await client("ada").command<Document>("createDocument", { upload: await upload("ada", text("private")), name: "draft.txt" }, { shape: SHAPE });

  const refused = await client("grace")
    .command<Document>("replaceContent", { id: doc.id, upload: await upload("grace", text("mine now")) }, { shape: SHAPE })
    .then(() => null, (e: RayfoldClientError) => e);
  expect(refused?.is("Forbidden")).toBe(true);
  expect(await (await fetch(`${base}${doc.url}`)).text()).toBe("private");

  const hers = await client("grace").query<{ items: Document[] }>("documents", {}, { shape: "{ items { id } }" });
  expect(hers.items).toEqual([]);
});

it("takes the bytes with the document when it is deleted", async () => {
  const ada = client("ada");
  const doc = await ada.command<Document>("createDocument", { upload: await upload("ada", text("temporary")), name: "draft.txt" }, { shape: SHAPE });
  expect(await readdir(dirs.files)).toHaveLength(1);

  await ada.command("deleteDocument", { id: doc.id }, { shape: "{ id }" });
  expect(await readdir(dirs.files)).toEqual([]);
  expect((await fetch(`${base}${doc.url}`)).status).toBe(404);
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
