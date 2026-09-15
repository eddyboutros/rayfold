/**
 * The playground's server: the real Rayfold runtime, running in the page. The bookshop schema runs the resolvers from
 * examples/typescript; any other schema runs on data generated from the schema itself, as `rayfold mock` does.
 */
import { RbCodec } from "@rayfold/rb";
import { loadSchema } from "@rayfold/schema";
import { createRayfoldServer, type Frame, type RayfoldServer, type RequestEnvelope } from "@rayfold/server/core";
import bookshopSchema from "../../../../examples/typescript/src/bookshop.rayfold?raw";
import { resolvers, seed, type Viewer } from "../../../../examples/typescript/src/resolvers.ts";
import { mockResolvers } from "../../../../packages/cli/src/mock.ts";
import type { ViewerName } from "./examples.ts";

export const BOOKSHOP_SCHEMA: string = bookshopSchema;

export const VIEWERS: Record<ViewerName, Viewer | null> = {
  anonymous: null,
  customer: { id: "u1", role: "customer" },
  staff: { id: "s1", role: "staff" },
};

export interface Engine {
  server: RayfoldServer;
  /** true when the schema is not the bookshop's, so answers come from generated data */
  mocked: boolean;
  codec: RbCodec;
}

const normalize = (text: string) => text.replace(/\r\n/g, "\n").trim();

/** A server for this schema text. Throws the reader's own error when the schema does not parse or validate. */
export function createEngine(schema: string): Engine {
  const mocked = normalize(schema) !== normalize(BOOKSHOP_SCHEMA);
  const loaded = loadSchema(schema);
  const server = createRayfoldServer({ schema: loaded, resolvers: mocked ? mockResolvers(loaded.ir) : resolvers(seed()) });
  return { server, mocked, codec: new RbCodec(server.ir) };
}

/** The envelope as sent: a command without an idempotency key gets a fresh one, as the client libraries do. */
export function prepare(engine: Engine, request: RequestEnvelope): RequestEnvelope {
  const envelope = structuredClone(request);
  for (const op of envelope.ops ?? []) {
    if (engine.server.ir.ops[op.op]?.kind === "command" && op.key === undefined) op.key = `pg-${crypto.randomUUID()}`;
  }
  return envelope;
}

export function execute(engine: Engine, envelope: RequestEnvelope, viewer: ViewerName, signal?: AbortSignal): AsyncIterable<Frame> {
  return engine.server.execute(envelope, { viewer: VIEWERS[viewer], ...(signal ? { signal } : {}) });
}

/** What the Restock button does: a member of staff adds copies, as another user of the shop would. */
export async function restock(engine: Engine, bookId: string, qty = 5): Promise<Frame[]> {
  const envelope = prepare(engine, { rayfold: "0.1", ops: [{ id: 1, op: "restock", args: { bookId, qty } }] } as RequestEnvelope);
  const frames: Frame[] = [];
  for await (const f of execute(engine, envelope, "staff")) frames.push(f);
  return frames;
}

/** Bytes on the wire for these frames, as NDJSON and as the binary format. */
export function sizes(engine: Engine, frames: Frame[]): { json: number; rb: number } {
  const json = new TextEncoder().encode(frames.map((f) => JSON.stringify(f) + "\n").join("")).length;
  return { json, rb: engine.codec.encodeFrames(frames).length };
}

export type FrameKind = "data" | "ok" | "patch" | "item" | "error" | "fin";

export function kindOf(frame: Frame): FrameKind {
  if ("error" in frame) return "error";
  if ("ok" in frame) return "ok";
  if ("data" in frame) return "data";
  if ("item" in frame) return "item";
  if ("patch" in frame) return "patch";
  return "fin";
}
