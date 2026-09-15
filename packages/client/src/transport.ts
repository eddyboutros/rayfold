/** Transports deliver a batch and yield frames. Spec: spec/04. */
import type { Frame, RequestEnvelope } from "@rayfold/server/protocol";
import { RbCodec, RB_CONTENT_TYPE } from "@rayfold/rb";
import { schemaHash, type RayfoldSchemaIR } from "@rayfold/schema";

export interface Transport {
  send(envelope: RequestEnvelope, opts?: { signal?: AbortSignal; safe?: boolean }): AsyncIterable<Frame>;
}

/** A schema with the hash the server gives it, as GET /rayfold/manifest serves them. */
export interface SchemaWithHash {
  schema: RayfoldSchemaIR;
  schemaHash: string;
}

export interface FetchTransportOptions {
  url: string;
  /** Extra headers per request (e.g. Authorization). */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  fetch?: typeof fetch;
  /** Use the HTTP QUERY method for safe batches when the runtime supports it. Default: POST + Rayfold-Safe. */
  useQueryMethod?: boolean;
  /**
   * Rayfold Binary: send and read RB instead of JSON. Pass the manifest from GET /rayfold/manifest, or the server's full
   * schema IR. RB key numbers come from the schema, so RB is used only once a response's Rayfold-Schema header shows the
   * server holds that same schema (spec 09 section 3). Until then, and after a response with another hash, requests go
   * as JSON. The manifest's `schema` on its own hashes differently from the server's schema, so pass the whole manifest.
   */
  binary?: RayfoldSchemaIR | SchemaWithHash;
}

/** HTTP transport: POST (or QUERY) /rayfold, response is newline-delimited frames streamed as they arrive. */
export function createFetchTransport(o: FetchTransportOptions): Transport {
  const f = o.fetch ?? globalThis.fetch;
  const rb = o.binary
    ? "schemaHash" in o.binary
      ? { codec: new RbCodec(o.binary.schema), hash: o.binary.schemaHash }
      : { codec: new RbCodec(o.binary), hash: schemaHash(o.binary) }
    : null;
  // the hash the server's last response reported; RB waits until it is known to match the codec's schema
  let serverHash: string | null = null;
  return {
    send(envelope, opts = {}) {
      return (async function* () {
        const codec = rb !== null && serverHash === rb.hash ? rb.codec : null;
        const headers: Record<string, string> = codec
          ? { "content-type": RB_CONTENT_TYPE, accept: RB_CONTENT_TYPE, ...(await o.headers?.()) }
          : { "content-type": "application/rayfold+json", accept: "application/rayfold-frames+json", ...(await o.headers?.()) };
        let method = "POST";
        if (opts.safe) {
          if (o.useQueryMethod) method = "QUERY";
          else headers["rayfold-safe"] = "true";
        }
        const init: RequestInit = { method, headers, body: codec ? (codec.encode(envelope) as BodyInit) : JSON.stringify(envelope) };
        if (opts.signal) init.signal = opts.signal;
        const res = await f(o.url, init);
        const reported = res.headers.get("rayfold-schema");
        if (reported) serverHash = reported;
        const ct = res.headers.get("content-type") ?? "";
        if (codec && ct.startsWith(RB_CONTENT_TYPE)) {
          if (reported !== rb?.hash) {
            // the server moved to another schema since the last response: its key numbers are not this codec's
            await res.body?.cancel();
            yield {
              error: { code: "unavailable", message: "The server's schema changed, so its binary answer cannot be read. Later requests use JSON; load the manifest again to use RB." },
              fin: true,
            } as Frame;
            return;
          }
          const d = codec.decoder();
          if (res.body) {
            const reader = res.body.getReader();
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              for (const fr of d.feed(value)) yield fr as Frame;
            }
          } else for (const fr of codec.decodeFrames(new Uint8Array(await res.arrayBuffer()))) yield fr as Frame;
          return;
        }
        if (!res.ok && !ct.startsWith("application/rayfold-frames+json")) {
          const body = ct.includes("json") ? await res.json().catch(() => ({})) : {};
          const code = typeof body.code === "string" ? body.code : "unavailable";
          yield { error: { code, message: body.detail ?? `HTTP ${res.status}` }, fin: true } as Frame;
          return;
        }
        if (!res.body) {
          const text = await res.text();
          for (const line of text.split("\n")) if (line.trim()) yield JSON.parse(line) as Frame;
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) yield JSON.parse(line) as Frame;
          }
        }
        if (buf.trim()) yield JSON.parse(buf) as Frame;
      })();
    },
  };
}

/** In-process transport over a RayfoldServer-like object (tests, SSR, workers). */
export function createLocalTransport(server: { execute(envelope: RequestEnvelope, opts?: { viewer?: unknown; signal?: AbortSignal }): AsyncIterable<Frame> }, viewer?: () => unknown): Transport {
  return {
    send(envelope, opts = {}) {
      const o: { viewer?: unknown; signal?: AbortSignal } = {};
      if (viewer) o.viewer = viewer();
      if (opts.signal) o.signal = opts.signal;
      return server.execute(envelope, o);
    },
  };
}
