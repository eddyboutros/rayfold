import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createFetchHandler } from "./fetch.ts";
import { ok } from "./executor.ts";
import { listen } from "./http.ts";
import { createRayfoldServer } from "./server.ts";
import { MemoryUploadStore } from "./uploads.ts";

/**
 * Uploads arrive on a route of their own and a command names what arrived. What is checked here is what a write is
 * checked for anywhere else: who sent it, where from, in what form, and how much of it (spec 12 §2, §3).
 */
const SCHEMA = `
  entity Avatar { id: ID bytes: Int }
  command setAvatar(userId: ID, upload: ID): Avatar
`;
const KEY = "0123456789abcdef";
const viewer = { id: "u1" };
const bytes = (n: number) => new Uint8Array(n).fill(65);

function build(opts: { store?: MemoryUploadStore; maxBytes?: number; viewerRequired?: boolean; who?: unknown } = {}) {
  const store = opts.store ?? new MemoryUploadStore();
  const taken: Array<{ userId: string; size: number }> = [];
  const server = createRayfoldServer({
    schema: SCHEMA,
    resolvers: {
      Command: {
        // what a resolver does with an upload: read it, use it, drop it
        setAvatar: async ({ userId, upload }: { userId: string; upload: string }) => {
          const kept = await store.open(upload);
          if (!kept) throw new RayfoldErrorLike("not_found", `No upload ${upload}`);
          let size = 0;
          const reader = kept.body.getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value?.length ?? 0;
          }
          await store.delete(upload);
          taken.push({ userId, size });
          return ok({ id: userId, bytes: size });
        },
      },
    },
  });
  const handler = createFetchHandler(server, {
    viewer: () => ("who" in opts ? opts.who : viewer),
    uploads: { store, ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}), ...(opts.viewerRequired !== undefined ? { viewerRequired: opts.viewerRequired } : {}) },
  });
  return { store, handler, taken };
}

/** A domain error the resolver can throw without importing the protocol's class into this test's narrative. */
class RayfoldErrorLike extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const send = (handler: (r: Request) => Promise<Response>, body: BodyInit | null, headers: Record<string, string> = {}) =>
  handler(new Request("http://api.example/rayfold/uploads", { method: "POST", headers: { "content-type": "application/octet-stream", ...headers }, body }));

const command = (handler: (r: Request) => Promise<Response>, upload: string) =>
  handler(
    new Request("http://api.example/rayfold", {
      method: "POST",
      headers: { "content-type": "application/rayfold+json", accept: "application/json" },
      body: JSON.stringify({ ops: [{ id: 1, op: "setAvatar", args: { userId: "u1", upload }, key: KEY }] }),
    }),
  );

describe("an upload arrives on its own route", () => {
  it("keeps the bytes and answers with the handle a command then names", async () => {
    const { handler, taken, store } = build();
    const res = await send(handler, bytes(2_048), { "rayfold-upload-name": "avatar.png", "rayfold-upload-type": "image/png" });
    expect(res.status).toBe(201);
    const kept = (await res.json()) as { id: string; size: number; name: string; type: string };
    expect(kept).toMatchObject({ size: 2_048, name: "avatar.png", type: "image/png" });
    expect(kept.id).toMatch(/[0-9a-f-]{8,}/);
    expect(store.size).toBe(1);

    const answer = await command(handler, kept.id);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ ok: { $type: "Avatar", id: "u1", bytes: 2_048 } });
    expect(taken).toEqual([{ userId: "u1", size: 2_048 }]);
    expect(store.size).toBe(0); // the resolver took what it needed and said so
  });

  it("refuses a content type a page could send cross-site without asking first", async () => {
    const { handler } = build();
    for (const type of ["multipart/form-data; boundary=x", "text/plain", "application/x-www-form-urlencoded"]) {
      const res = await send(handler, bytes(8), { "content-type": type });
      expect(res.status, type).toBe(415);
      expect((await res.json()) as { detail: string }).toMatchObject({ detail: expect.stringContaining("application/octet-stream") });
    }
  });

  it("applies the Origin rule, because an upload is a write", async () => {
    const { handler, store } = build();
    const res = await send(handler, bytes(8), { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(store.size).toBe(0);
    // guard: the server's own origin is allowed
    expect((await send(handler, bytes(8), { origin: "http://api.example" })).status).toBe(201);
  });

  it("needs an identified sender unless the server says otherwise", async () => {
    const anonymous = build({ who: null });
    const refused = await send(anonymous.handler, bytes(8));
    expect(refused.status).toBe(401);
    expect(anonymous.store.size).toBe(0);

    const open = build({ who: null, viewerRequired: false });
    expect((await send(open.handler, bytes(8))).status).toBe(201);
  });

  it("stops at the size bound while reading, whatever the request claimed", async () => {
    const { handler, store } = build({ maxBytes: 1_024 });
    const declared = await send(handler, bytes(2_048), { "content-length": "2048" });
    expect(declared.status).toBe(413);

    // a body that understates its length is still stopped, because the bytes are counted as they pass
    const streamed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes(800));
        controller.enqueue(bytes(800));
        controller.close();
      },
    });
    const lying = await handler(
      new Request("http://api.example/rayfold/uploads", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: streamed, duplex: "half" } as RequestInit),
    );
    expect(lying.status).toBe(413);
    expect(store.size).toBe(0);

    // guard: one just inside the bound is kept
    expect((await send(handler, bytes(1_024))).status).toBe(201);
    expect(store.size).toBe(1);
  });

  it("is not there at all unless a store was given", async () => {
    const server = createRayfoldServer({ schema: SCHEMA, resolvers: { Command: { setAvatar: () => ok({ id: "u1", bytes: 0 }) } } });
    const bare = createFetchHandler(server);
    const res = await send(bare, bytes(8));
    expect(res.status).toBe(404);
  });

  it("answers a command that names an upload which is gone", async () => {
    const { handler } = build();
    const res = await command(handler, "no-such-upload");
    expect(res.status).toBe(500); // the resolver threw; what matters is that nothing else was served in its place
    expect((await res.json()) as { error: { message: string } }).toMatchObject({ error: { code: "internal" } });
  });
});

describe("over a Node server", () => {
  const open: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      open.splice(0).map(
        (h) =>
          new Promise<void>((r) => {
            h.close(() => r());
            h.closeAllConnections();
          }),
      ),
    );
  });

  it("an upload is bounded by its own limit, not the envelope's, and the envelope's still holds", async () => {
    const store = new MemoryUploadStore();
    const server = createRayfoldServer({ schema: SCHEMA, resolvers: { Command: { setAvatar: () => ok({ id: "u1", bytes: 0 }) } } });
    // an envelope may be 1 KiB here; an upload may be 4 MiB, which is the point of a route of its own
    const http = await listen(server, 0, { viewer: () => viewer, maxBody: 1_024, uploads: { store, maxBytes: 4 * 1024 * 1024 } });
    open.push(http);
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

    const big = await fetch(`${base}/rayfold/uploads`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: bytes(2 * 1024 * 1024) });
    expect(big.status).toBe(201);
    expect((await big.json()) as { size: number }).toMatchObject({ size: 2 * 1024 * 1024 });
    expect(store.bytes).toBe(2 * 1024 * 1024);

    // guard: the batch endpoint is unchanged, and still refuses a body over its own smaller limit
    const envelope = await fetch(`${base}/rayfold`, {
      method: "POST",
      headers: { "content-type": "application/rayfold+json" },
      body: JSON.stringify({ ops: [{ id: 1, op: "setAvatar", args: { userId: "u1", upload: "x".repeat(2_048) }, key: KEY }] }),
    });
    expect(envelope.status).toBe(413);

    // and an upload past its own limit is still refused
    const tooBig = await listen(createRayfoldServer({ schema: SCHEMA, resolvers: { Command: { setAvatar: () => ok({ id: "u1", bytes: 0 }) } } }), 0, {
      viewer: () => viewer,
      uploads: { store, maxBytes: 1_024 },
    });
    open.push(tooBig);
    const refused = await fetch(`http://127.0.0.1:${(tooBig.address() as AddressInfo).port}/rayfold/uploads`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: bytes(4_096),
    });
    expect(refused.status).toBe(413);
  });

  it("says it serves the upload extension in its manifest, and does not when it has no store", async () => {
    const withStore = await listen(createRayfoldServer({ schema: SCHEMA, resolvers: { Command: { setAvatar: () => ok({ id: "u1", bytes: 0 }) } } }), 0, {
      uploads: { store: new MemoryUploadStore() },
    });
    open.push(withStore);
    const served = (await (await fetch(`http://127.0.0.1:${(withStore.address() as AddressInfo).port}/rayfold/manifest`)).json()) as { extensions: string[] };
    expect(served.extensions).toContain("upload");

    const without = await listen(createRayfoldServer({ schema: SCHEMA, resolvers: { Command: { setAvatar: () => ok({ id: "u1", bytes: 0 }) } } }), 0);
    open.push(without);
    const bare = (await (await fetch(`http://127.0.0.1:${(without.address() as AddressInfo).port}/rayfold/manifest`)).json()) as { extensions: string[] };
    expect(bare.extensions).not.toContain("upload");
  });
});

describe("the store in memory", () => {
  it("forgets an upload nobody used, and says so rather than serving stale bytes", async () => {
    let now = 1_000;
    const store = new MemoryUploadStore({ ttlMs: 60_000, now: () => now });
    const kept = await store.put(bodyOf(bytes(16)), { name: "a.bin" });
    now += 59_999;
    expect(await store.open(kept.id)).toBeDefined();
    now += 2;
    expect(await store.open(kept.id)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("keeps itself inside its bound, oldest first", async () => {
    let now = 0;
    const store = new MemoryUploadStore({ maxBytes: 2_048, now: () => now });
    const first = await store.put(bodyOf(bytes(1_024)), {});
    now += 1;
    const second = await store.put(bodyOf(bytes(1_024)), {});
    expect(store.bytes).toBe(2_048);
    now += 1;
    const third = await store.put(bodyOf(bytes(1_024)), {});

    expect(await store.open(first.id)).toBeUndefined(); // the oldest made room
    expect(await store.open(second.id)).toBeDefined();
    expect(await store.open(third.id)).toBeDefined();
    expect(store.bytes).toBe(2_048);
  });

  it("gives the bytes back as they arrived, once", async () => {
    const store = new MemoryUploadStore();
    const payload = new Uint8Array([1, 2, 3, 250, 251]);
    const kept = await store.put(bodyOf(payload), { type: "application/x-thing" });
    const opened = await store.open(kept.id);
    expect(opened?.upload).toMatchObject({ size: 5, type: "application/x-thing" });
    const read: number[] = [];
    const reader = opened!.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      read.push(...(value ?? []));
    }
    expect(read).toEqual([1, 2, 3, 250, 251]);
    await store.delete(kept.id);
    expect(await store.open(kept.id)).toBeUndefined();
    expect(store.bytes).toBe(0);
  });
});

function bodyOf(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
}
