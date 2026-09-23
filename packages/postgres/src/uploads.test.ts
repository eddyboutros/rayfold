import { PGlite } from "@electric-sql/pglite";
import { MemoryUploadStore, createFetchHandler, createRayfoldServer, ok, type UploadStore } from "@rayfold/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PgUploadStore, type Queryable } from "./index.ts";

/**
 * Uploads in Postgres, with two servers over one database: the point of the store is that a file sent to one server is
 * there for the command that runs on another. Everything else a store must do - forget what nobody used, stay inside
 * its bound, give the bytes back as they arrived - is checked against a real database rather than a map.
 */
const SCHEMA = `
  entity Avatar { id: ID bytes: Int name: String? }
  command setAvatar(userId: ID, upload: ID): Avatar
`;
const viewer = { id: "u1" };
const bytes = (n: number, fill = 65) => new Uint8Array(n).fill(fill);
const bodyOf = (data: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });

let db: PGlite;
let sql: Queryable;
let now = 1_000;

beforeEach(async () => {
  db = new PGlite();
  sql = { query: async (text, params) => (await db.query(text, params)) as never };
  now = 1_000;
});

afterEach(async () => {
  await db.close();
});

async function store(opts: { ttlMs?: number; maxBytes?: number } = {}): Promise<PgUploadStore> {
  const s = new PgUploadStore(sql, { now: () => now, ...opts });
  await s.migrate();
  return s;
}

/** A server that takes uploads and a command that consumes them, as a member of a fleet would. */
function member(uploads: UploadStore) {
  const server = createRayfoldServer({
    schema: SCHEMA,
    resolvers: {
      Command: {
        setAvatar: async ({ userId, upload }: { userId: string; upload: string }) => {
          const kept = await uploads.open(upload);
          if (!kept) return ok({ id: userId, bytes: 0, name: null });
          let size = 0;
          const reader = kept.body.getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value?.length ?? 0;
          }
          await uploads.delete(upload);
          return ok({ id: userId, bytes: size, name: kept.upload.name ?? null });
        },
      },
    },
  });
  return createFetchHandler(server, { viewer: () => viewer, uploads: { store: uploads } });
}

const send = (handler: (r: Request) => Promise<Response>, data: Uint8Array, headers: Record<string, string> = {}) =>
  handler(new Request("http://api.example/rayfold/uploads", { method: "POST", headers: { "content-type": "application/octet-stream", ...headers }, body: data as BodyInit }));

const consume = (handler: (r: Request) => Promise<Response>, id: string, key: string) =>
  handler(
    new Request("http://api.example/rayfold", {
      method: "POST",
      headers: { "content-type": "application/rayfold+json", accept: "application/json" },
      body: JSON.stringify({ ops: [{ id: 1, op: "setAvatar", args: { userId: "u1", upload: id }, key }] }),
    }),
  );

describe("uploads in Postgres", () => {
  it("a file sent to one server is used by a command on another", async () => {
    const shared = await store();
    const a = member(shared);
    const b = member(shared);

    const sent = await send(a, bytes(4_096), { "rayfold-upload-name": "avatar.png", "rayfold-upload-type": "image/png" });
    expect(sent.status).toBe(201);
    const kept = (await sent.json()) as { id: string; size: number };
    expect(kept.size).toBe(4_096);
    expect((await shared.open(kept.id))?.upload).toEqual({ id: kept.id, size: 4_096, at: 1_000, name: "avatar.png", type: "image/png", viewer });

    const answer = await consume(b, kept.id, "0123456789abcdef");
    expect(await answer.json()).toMatchObject({ ok: { id: "u1", bytes: 4_096, name: "avatar.png" } });
    expect(await shared.count()).toBe(0); // the command took it and said so

    // guard: a server that keeps uploads to itself never sees what another one was sent, which is the whole point
    const c = member(new MemoryUploadStore());
    const other = (await (await send(a, bytes(16))).json()) as { id: string };
    expect(await (await consume(c, other.id, "0123456789abcdeg")).json()).toMatchObject({ ok: { bytes: 0 } });
    // three servers and a WASM Postgres between them: the default bound is the suite's, not this test's
  }, 20_000);

  it("gives the bytes back exactly as they arrived, with what the client said about them", async () => {
    const s = await store();
    const payload = new Uint8Array([0, 1, 250, 255, 13, 10]);
    const kept = await s.put(bodyOf(payload), { name: "raw.bin", type: "application/octet-stream", viewer });
    const opened = await s.open(kept.id);
    expect(opened?.upload).toMatchObject({ size: 6, name: "raw.bin", type: "application/octet-stream", viewer });

    const read: number[] = [];
    const reader = opened!.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      read.push(...(value ?? []));
    }
    expect(read).toEqual([0, 1, 250, 255, 13, 10]); // high bytes and newlines survive the round trip
  });

  it("forgets an upload nobody used, at its lifetime and not before", async () => {
    const s = await store({ ttlMs: 60_000 });
    const kept = await s.put(bodyOf(bytes(32)), {});
    now += 59_999;
    expect((await s.open(kept.id))?.upload).toEqual({ id: kept.id, size: 32, at: 1_000 });
    now += 2;
    expect(await s.open(kept.id)).toBeUndefined();
    expect(await s.count()).toBe(0); // reading it away is what dropped it
  });

  it("keeps itself inside its bound, oldest first", async () => {
    const s = await store({ maxBytes: 2_048 });
    const first = await s.put(bodyOf(bytes(1_024)), {});
    now += 1;
    const second = await s.put(bodyOf(bytes(1_024)), {});
    expect(await s.bytes()).toBe(2_048);
    now += 1;
    const third = await s.put(bodyOf(bytes(1_024)), {});

    expect(await s.open(first.id)).toBeUndefined();
    expect((await s.open(second.id))?.upload).toEqual({ id: second.id, size: 1_024, at: 1_001 });
    expect((await s.open(third.id))?.upload).toEqual({ id: third.id, size: 1_024, at: 1_002 });
    expect(await s.bytes()).toBe(2_048);
  });

  it("two servers may each create the table as they start", async () => {
    const [a, b] = await Promise.all([store(), store()]);
    const kept = await a.put(bodyOf(bytes(8)), { name: "x" });
    expect((await b.open(kept.id))?.upload).toEqual({ id: kept.id, size: 8, at: 1_000, name: "x" }); // one table, whichever of them made it
    expect(await b.count()).toBe(1);
  });

  it("delete makes it gone, and deleting what is gone is not an error", async () => {
    const s = await store();
    const kept = await s.put(bodyOf(bytes(8)), {});
    await s.delete(kept.id);
    expect(await s.open(kept.id)).toBeUndefined();
    await s.delete(kept.id);
    expect(await s.count()).toBe(0);
  });
});
