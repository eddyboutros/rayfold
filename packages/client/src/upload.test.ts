import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MemoryUploadStore, createRayfoldServer, listen, ok } from "@rayfold/server";
import { RayfoldClient, RayfoldClientError } from "./client.ts";
import { createFetchTransport, createLocalTransport } from "./transport.ts";

/**
 * `client.upload()` against a real server: the bytes go to the upload route, the handle comes back, and the command
 * that names it sees what arrived. The client's part is small on purpose - an upload is bytes going one way - so what
 * is checked is that it sends what the route requires and reports a refusal as an error a caller can read.
 */
const SCHEMA = `
  entity Avatar { id: ID bytes: Int name: String? }
  command setAvatar(userId: ID, upload: ID): Avatar
`;
const viewer = { id: "u1" };

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

async function serve(opts: { maxBytes?: number; viewerRequired?: boolean; who?: unknown } = {}) {
  const store = new MemoryUploadStore();
  const server = createRayfoldServer({
    schema: SCHEMA,
    resolvers: {
      Command: {
        setAvatar: async ({ userId, upload }: { userId: string; upload: string }) => {
          const kept = await store.open(upload);
          if (!kept) return ok({ id: userId, bytes: 0, name: null });
          let size = 0;
          const reader = kept.body.getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value?.length ?? 0;
          }
          await store.delete(upload);
          return ok({ id: userId, bytes: size, name: kept.upload.name ?? null });
        },
      },
    },
  });
  const http = await listen(server, 0, {
    viewer: () => ("who" in opts ? opts.who : viewer),
    uploads: { store, ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}), ...(opts.viewerRequired !== undefined ? { viewerRequired: opts.viewerRequired } : {}) },
  });
  open.push(http);
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/rayfold`;
  let keys = 0;
  return { store, url, client: new RayfoldClient({ transport: createFetchTransport({ url }), keyGen: () => `key-${String(++keys).padStart(12, "0")}` }) };
}

describe("client.upload", () => {
  it("sends the bytes and answers with the handle the command then names", async () => {
    const { client, store } = await serve();
    const kept = await client.upload(new Uint8Array(1_500).fill(7));
    expect(kept).toMatchObject({ size: 1_500 });
    expect(store.size).toBe(1);

    const avatar = await client.command<{ bytes: number }>("setAvatar", { userId: "u1", upload: kept.id });
    expect(avatar).toMatchObject({ bytes: 1_500 });
    expect(store.size).toBe(0);
  });

  it("takes a File's own name and type, and lets the caller say otherwise", async () => {
    const { client } = await serve();
    const file = new File([new Uint8Array(32)], "avatar.png", { type: "image/png" });
    const fromFile = await client.upload(file);
    expect(fromFile).toMatchObject({ size: 32, name: "avatar.png", type: "image/png" });

    const renamed = await client.upload(file, { name: "other.bin" });
    expect(renamed).toMatchObject({ name: "other.bin", type: "image/png" });

    // the command sees what the server kept, not what the client remembers
    const avatar = await client.command<{ name: string }>("setAvatar", { userId: "u1", upload: renamed.id });
    expect(avatar).toMatchObject({ name: "other.bin" });
  });

  it("reports a refusal as an error a caller can read, and one worth retrying is marked so", async () => {
    const small = await serve({ maxBytes: 64 });
    const tooBig = await small.client.upload(new Uint8Array(4_096)).catch((e: unknown) => e);
    expect(tooBig).toBeInstanceOf(RayfoldClientError);
    expect(tooBig as RayfoldClientError).toMatchObject({ code: "resource_exhausted", retryable: false });
    expect(small.store.size).toBe(0);

    const anonymous = await serve({ who: null });
    const refused = await anonymous.client.upload(new Uint8Array(8)).catch((e: unknown) => e);
    expect((refused as RayfoldClientError).code).toBe("unauthenticated");
  });

  it("says plainly when the transport has nowhere to send bytes", async () => {
    const { store: _store } = await serve();
    const inProcess = createRayfoldServer({ schema: SCHEMA, resolvers: { Command: { setAvatar: () => ok({ id: "u1", bytes: 0, name: null }) } } });
    const client = new RayfoldClient({ transport: createLocalTransport(inProcess, () => viewer) });
    const failed = await client.upload(new Uint8Array(8)).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(RayfoldClientError);
    expect((failed as RayfoldClientError).code).toBe("unimplemented");
    expect((failed as RayfoldClientError).message).toContain("cannot upload");
  });

  it("carries the headers the transport was given, so an upload is authorised like any other request", async () => {
    const store = new MemoryUploadStore();
    const server = createRayfoldServer({ schema: SCHEMA, resolvers: { Command: { setAvatar: () => ok({ id: "u1", bytes: 0, name: null }) } } });
    const http = await listen(server, 0, {
      viewer: (req) => (req.headers.authorization === "Bearer good" ? viewer : null),
      uploads: { store },
    });
    open.push(http);
    const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/rayfold`;

    const authorised = new RayfoldClient({ transport: createFetchTransport({ url, headers: () => ({ authorization: "Bearer good" }) }) });
    expect(await authorised.upload(new Uint8Array(16))).toMatchObject({ size: 16 });

    const anonymous = new RayfoldClient({ transport: createFetchTransport({ url }) });
    await expect(anonymous.upload(new Uint8Array(16))).rejects.toMatchObject({ code: "unauthenticated" });
  });
});
