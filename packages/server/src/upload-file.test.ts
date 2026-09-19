import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFetchHandler } from "./fetch.ts";
import { ok } from "./executor.ts";
import { createRayfoldServer } from "./server.ts";
import { FileUploadStore } from "./upload-file.ts";

/**
 * The bytes of an upload as a file on disk. What is checked is what the class exists for: they are streamed to a
 * named file and back, an id can never name anything outside the directory, and nothing nobody claimed is kept.
 */
const SCHEMA = `
  entity Saved { id: ID bytes: Int }
  command save(upload: ID): Saved
`;
const KEY = "0123456789abcdef";
const filling = (n: number, byte = 65) => new Uint8Array(n).fill(byte);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rayfold-uploads-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The upload route and a command that reads what arrived, as an application wires them. */
function build(store: FileUploadStore) {
  const read: number[] = [];
  const server = createRayfoldServer({
    schema: SCHEMA,
    resolvers: {
      Command: {
        save: async ({ upload }: { upload: string }) => {
          const kept = await store.open(upload);
          let size = 0;
          if (kept) {
            const reader = kept.body.getReader();
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              size += value?.length ?? 0;
            }
            await store.delete(upload);
          }
          read.push(size);
          return ok({ id: upload, bytes: size });
        },
      },
    },
  });
  const handler = createFetchHandler(server, { viewer: () => ({ id: "u1" }), uploads: { store } });
  return { handler, read };
}

const post = (handler: (r: Request) => Promise<Response>, body: BodyInit) =>
  handler(new Request("http://api.example/rayfold/uploads", { method: "POST", headers: { "content-type": "application/octet-stream" }, body }));

const save = (handler: (r: Request) => Promise<Response>, upload: string) =>
  handler(
    new Request("http://api.example/rayfold", {
      method: "POST",
      headers: { "content-type": "application/rayfold+json", accept: "application/json" },
      body: JSON.stringify({ ops: [{ id: 1, op: "save", args: { upload }, key: KEY }] }),
    }),
  );

describe("uploads on disk", () => {
  it("writes the bytes to a file the command then reads back", async () => {
    const store = new FileUploadStore({ dir });
    const { handler, read } = build(store);

    const res = await post(handler, filling(4 * 1024 * 1024));
    expect(res.status).toBe(201);
    const kept = (await res.json()) as { id: string; size: number };
    expect(kept.size).toBe(4 * 1024 * 1024);

    // the point of this store: the bytes are a file, sized as sent, not a buffer and not a database row
    expect(await stat(join(dir, `${kept.id}.bin`))).toMatchObject({ size: 4 * 1024 * 1024 });

    const answer = await save(handler, kept.id);
    expect(await answer.json()).toMatchObject({ ok: { $type: "Saved", bytes: 4 * 1024 * 1024 } });
    expect(read).toEqual([4 * 1024 * 1024]);
    expect(await readdir(dir)).toEqual([]); // the command took what it needed and said so
  });

  it("hands back the bytes that were sent, not merely their count", async () => {
    const store = new FileUploadStore({ dir });
    const { handler } = build(store);
    const sent = Uint8Array.from({ length: 512 }, (_, i) => i % 256);

    const kept = (await (await post(handler, sent)).json()) as { id: string };
    expect(new Uint8Array(await readFile(join(dir, `${kept.id}.bin`)))).toEqual(sent);
  });

  it("keeps what a command has not claimed yet, and drops it once its lifetime has passed", async () => {
    let clock = 1_000;
    const store = new FileUploadStore({ dir, ttlMs: 60_000, now: () => clock });
    const { handler } = build(store);
    const kept = (await (await post(handler, filling(16))).json()) as { id: string };

    // guard: inside its lifetime it is still there, so the sweep below is not simply dropping everything
    clock += 59_999;
    expect(await store.open(kept.id)).toBeDefined();

    clock += 1;
    expect(await store.open(kept.id)).toBeUndefined();
    expect(await readdir(dir)).toEqual([]);
  });

  it("sweeps an abandoned upload when the next one arrives", async () => {
    let clock = 1_000;
    const store = new FileUploadStore({ dir, ttlMs: 60_000, now: () => clock });
    const { handler } = build(store);
    const abandoned = (await (await post(handler, filling(16))).json()) as { id: string };

    clock += 60_000;
    const fresh = (await (await post(handler, filling(32))).json()) as { id: string };

    expect(await readdir(dir)).toEqual([`${fresh.id}.bin`, `${fresh.id}.json`].sort());
    expect(await store.open(abandoned.id)).toBeUndefined();
  });

  it("refuses an id that would name a file outside the directory", async () => {
    const store = new FileUploadStore({ dir });
    const { handler } = build(store);

    // a whole upload, bytes and metadata, one level up: without the rule on ids `../escape` opens it
    const outside = join(dir, "..");
    await writeFile(join(outside, "escape.bin"), "not yours", "utf8");
    await writeFile(join(outside, "escape.json"), JSON.stringify({ id: "escape", size: 9, at: Date.now() }), "utf8");

    try {
      for (const id of ["../escape", "..\\escape", "/etc/passwd", "a/b", ""]) {
        expect(await store.open(id), id).toBeUndefined();
      }
      // guard: a real id is still served, so the rule refuses names rather than everything
      const kept = (await (await post(handler, filling(8))).json()) as { id: string };
      expect(await store.open(kept.id)).toBeDefined();
      expect(await readFile(join(outside, "escape.bin"), "utf8")).toBe("not yours");
    } finally {
      await rm(join(outside, "escape.bin"), { force: true });
      await rm(join(outside, "escape.json"), { force: true });
    }
  });

  it("leaves nothing behind when the body fails part way through", async () => {
    const store = new FileUploadStore({ dir });
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(filling(1024));
        controller.error(new Error("the connection went away"));
      },
    });

    await expect(store.put(failing, {})).rejects.toThrow("the connection went away");
    expect(await readdir(dir)).toEqual([]);
  });

  it("delete takes the bytes and the metadata together", async () => {
    const store = new FileUploadStore({ dir });
    const { handler } = build(store);
    const kept = (await (await post(handler, filling(64))).json()) as { id: string };
    expect(await readdir(dir)).toHaveLength(2);

    await store.delete(kept.id);
    expect(await readdir(dir)).toEqual([]);
    expect(await store.open(kept.id)).toBeUndefined();
  });
});
