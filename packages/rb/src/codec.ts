/**
 * RB is Rayfold Binary (extension `rb`, spec/09). Same value model as JSON, compact on the wire:
 *  - schema-derived key dictionary: object keys that are field/frame names encode as small varints
 *  - per-message string table: repeated strings (type names, ids, enum values) encode once
 *  - zigzag varints, 8-byte doubles only when needed, tagged values otherwise
 * Frames are length-prefixed so a stream can be decoded incrementally.
 */
import type { RayfoldSchemaIR } from "@rayfold/schema";

const T_NULL = 0x00;
const T_FALSE = 0x01;
const T_TRUE = 0x02;
const T_INT = 0x03; // zigzag varint
const T_F64 = 0x04;
const T_STR = 0x05; // varint len + utf8, added to string table
const T_STR_REF = 0x06; // varint index into string table
const T_ARR = 0x07; // varint count
const T_OBJ = 0x08; // varint count, then key,value pairs
const T_BYTES = 0x09;
const T_SMALL = 0x80; // 0x80..0xff: small non-negative int 0..127

/** Keys every implementation knows, independent of the schema (ids 0..31 reserved). */
export const FRAME_KEYS = [
  "id", "op", "args", "shape", "vars", "key", "live", "deadline", "simulate", "ops", "meta", "rayfold",
  "data", "ok", "item", "patch", "at", "error", "fin", "errors", "code", "type", "message", "path", "retryable",
  "set", "value", "del", "inv", "invOp", "cost", "cache", "$type", "$ref", "client", "replay", "cursor", "ms",
  "list", "ins",
];

export class KeyDictionary {
  readonly ids = new Map<string, number>();
  readonly names: string[] = [];
  constructor(ir?: RayfoldSchemaIR) {
    for (const k of FRAME_KEYS) this.add(k);
    if (ir) {
      const names = new Set<string>();
      for (const t of Object.values(ir.types)) {
        if ("fields" in t) for (const f of t.fields) {
          names.add(f.name);
          for (const a of f.args) names.add(a.name);
        }
        if (t.kind === "enum") for (const v of t.values) names.add(v.name);
      }
      for (const op of Object.values(ir.ops)) {
        names.add(op.name);
        for (const a of op.args) names.add(a.name);
      }
      for (const n of [...names].sort()) this.add(n);
    }
  }
  private add(name: string): void {
    if (this.ids.has(name)) return;
    this.ids.set(name, this.names.length);
    this.names.push(name);
  }
}

class Writer {
  private buf = new Uint8Array(1024);
  private len = 0;
  private readonly strings = new Map<string, number>();
  constructor(private readonly dict: KeyDictionary) {}

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  byte(b: number): void {
    this.ensure(1);
    this.buf[this.len++] = b;
  }
  varint(n: number): void {
    // unsigned, up to 2^53
    this.ensure(8);
    while (n >= 0x80) {
      this.buf[this.len++] = (n % 0x80) | 0x80;
      n = Math.floor(n / 0x80);
    }
    this.buf[this.len++] = n;
  }
  bigVarint(n: bigint): void {
    while (n >= 0x80n) {
      this.byte(Number(n & 0x7fn) | 0x80);
      n >>= 7n;
    }
    this.byte(Number(n));
  }
  raw(bytes: Uint8Array): void {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }
  string(s: string): void {
    const idx = this.strings.get(s);
    if (idx !== undefined) {
      this.byte(T_STR_REF);
      this.varint(idx);
      return;
    }
    const bytes = utf8.encode(s);
    this.byte(T_STR);
    this.varint(bytes.length);
    this.raw(bytes);
    this.strings.set(s, this.strings.size);
  }
  key(k: string): void {
    const id = this.dict.ids.get(k);
    if (id !== undefined) this.varint(id * 2);
    else {
      const bytes = utf8.encode(k);
      this.varint(bytes.length * 2 + 1);
      this.raw(bytes);
    }
  }
  value(v: unknown): void {
    if (v === null || v === undefined) return this.byte(T_NULL);
    switch (typeof v) {
      case "boolean":
        return this.byte(v ? T_TRUE : T_FALSE);
      case "number": {
        // what JSON sends for these, so a value reads the same whichever encoding carried it
        if (!Number.isFinite(v)) return this.byte(T_NULL);
        if (Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER) {
          if (v >= 0 && v < 128) return this.byte(T_SMALL | v);
          this.byte(T_INT);
          // above 2^52 the zigzag value passes 2^53, where a double drops the low bit that carries the sign
          if (Math.abs(v) > 2 ** 52) return this.bigVarint(v >= 0 ? BigInt(v) * 2n : -BigInt(v) * 2n - 1n);
          return this.varint(v >= 0 ? v * 2 : -v * 2 - 1);
        }
        this.byte(T_F64);
        this.ensure(8);
        new DataView(this.buf.buffer, this.buf.byteOffset + this.len, 8).setFloat64(0, v, true);
        this.len += 8;
        return;
      }
      case "string":
        return this.string(v);
      case "bigint":
        return this.string(v.toString());
      case "object": {
        if (Array.isArray(v)) {
          this.byte(T_ARR);
          this.varint(v.length);
          for (const x of v) this.value(x);
          return;
        }
        if (v instanceof Uint8Array) {
          this.byte(T_BYTES);
          this.varint(v.length);
          return this.raw(v);
        }
        // a Date (or anything else with toJSON) travels as what JSON.stringify would send, not as its own fields
        const own = v as { toJSON?: unknown };
        if (typeof own.toJSON === "function") return this.value((own.toJSON as () => unknown).call(v));
        const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
        this.byte(T_OBJ);
        this.varint(entries.length);
        for (const [k, x] of entries) {
          this.key(k);
          this.value(x);
        }
        return;
      }
      default:
        return this.byte(T_NULL);
    }
  }
  bytes(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

/** Nesting limit for decoded values; also bounds recursion on hostile input. */
const MAX_NESTING = 64;
/**
 * How far string references may expand a message: 16 times its length, or 1 MiB if that is more. A reference is two
 * bytes that stand for a string of any size, so without a bound a small body stands for gigabytes once anything hashes
 * or prints it. The floor keeps a response that repeats a long string across many items readable.
 */
const MAX_EXPANSION = 16;
const EXPANSION_FLOOR = 1_048_576;

class Reader {
  pos = 0;
  private readonly strings: string[] = [];
  /** UTF-8 length of each entry of `strings`, and the bytes the references read so far stood for. */
  private readonly lengths: number[] = [];
  private expanded = 0;
  constructor(
    private readonly buf: Uint8Array,
    private readonly dict: KeyDictionary,
    readonly end: number = buf.length,
  ) {}
  byte(): number {
    if (this.pos >= this.end) throw new RangeError("RB: unexpected end of input");
    return this.buf[this.pos++]!;
  }
  varint(): number {
    let n = 0;
    let mul = 1;
    for (;;) {
      const b = this.byte();
      n += (b & 0x7f) * mul;
      if (b < 0x80) return n;
      mul *= 0x80;
      if (mul > 2 ** 56) throw new RangeError("RB: varint too long");
    }
  }
  /** A varint that varint() already accepted, read exactly. */
  bigVarint(): bigint {
    let n = 0n;
    for (let shift = 0n; ; shift += 7n) {
      const b = this.byte();
      n |= BigInt(b & 0x7f) << shift;
      if (b < 0x80) return n;
    }
  }
  raw(n: number): Uint8Array {
    if (this.pos + n > this.end) throw new RangeError("RB: unexpected end of input");
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  key(): string {
    const k = this.varint();
    if (k % 2 === 0) {
      const name = this.dict.names[k / 2];
      if (name === undefined) throw new RangeError(`RB: unknown key id ${k / 2}`);
      return name;
    }
    return utf8.decode(this.raw((k - 1) / 2));
  }
  /** Element count of a list or object, checked against the nesting limit and the bytes that are left. */
  private count(depth: number, minBytesEach: number): number {
    if (depth >= MAX_NESTING) throw new RangeError(`RB: nested deeper than ${MAX_NESTING} levels`);
    const n = this.varint();
    if (n * minBytesEach > this.end - this.pos) throw new RangeError("RB: length exceeds the input");
    return n;
  }
  value(depth = 0): unknown {
    const t = this.byte();
    if (t >= T_SMALL) return t & 0x7f;
    switch (t) {
      case T_NULL:
        return null;
      case T_FALSE:
        return false;
      case T_TRUE:
        return true;
      case T_INT: {
        const start = this.pos;
        const zz = this.varint();
        if (zz <= Number.MAX_SAFE_INTEGER) return zz % 2 === 0 ? zz / 2 : -(zz + 1) / 2;
        // past 2^53 the double lost the low bit that carries the sign: read the value again exactly
        this.pos = start;
        const big = this.bigVarint();
        return Number(big % 2n === 0n ? big / 2n : -(big + 1n) / 2n);
      }
      case T_F64: {
        if (this.pos + 8 > this.end) throw new RangeError("RB: unexpected end of input");
        const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8).getFloat64(0, true);
        this.pos += 8;
        return v;
      }
      case T_STR: {
        const bytes = this.raw(this.varint());
        const s = utf8.decode(bytes);
        this.strings.push(s);
        this.lengths.push(bytes.length);
        return s;
      }
      case T_STR_REF: {
        const i = this.varint();
        const s = this.strings[i];
        if (s === undefined) throw new RangeError("RB: bad string reference");
        this.expanded += this.lengths[i]!;
        if (this.expanded > Math.max(MAX_EXPANSION * this.end, EXPANSION_FLOOR)) throw new RangeError(`RB: string references expand past ${MAX_EXPANSION} times the message`);
        return s;
      }
      case T_ARR: {
        const n = this.count(depth, 1);
        const out = new Array<unknown>(n);
        for (let i = 0; i < n; i++) out[i] = this.value(depth + 1);
        return out;
      }
      case T_OBJ: {
        const n = this.count(depth, 2);
        const out: Record<string, unknown> = {};
        for (let i = 0; i < n; i++) {
          const k = this.key();
          // an own property, as JSON.parse makes it: assigning "__proto__" would replace the object's prototype
          Object.defineProperty(out, k, { value: this.value(depth + 1), enumerable: true, writable: true, configurable: true });
        }
        return out;
      }
      case T_BYTES:
        return this.raw(this.varint()).slice();
      default:
        throw new RangeError(`RB: unknown tag 0x${t.toString(16)}`);
    }
  }
}

const utf8 = { encode: (s: string) => new TextEncoder().encode(s), decode: (b: Uint8Array) => new TextDecoder().decode(b) };

export class RbCodec {
  readonly dict: KeyDictionary;
  constructor(ir?: RayfoldSchemaIR) {
    this.dict = new KeyDictionary(ir);
  }
  /** One value, no length prefix. */
  encode(value: unknown): Uint8Array {
    const w = new Writer(this.dict);
    w.value(value);
    return w.bytes();
  }
  decode(bytes: Uint8Array): unknown {
    const r = new Reader(bytes, this.dict);
    const v = r.value();
    if (r.pos !== bytes.length) throw new RangeError("RB: trailing bytes");
    return v;
  }
  /** Length-prefixed sequence of frames (what goes over HTTP/WS). */
  encodeFrames(frames: unknown[]): Uint8Array {
    const parts = frames.map((f) => this.encode(f));
    const total = parts.reduce((n, p) => n + varintSize(p.length) + p.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) {
      pos = writeVarint(out, pos, p.length);
      out.set(p, pos);
      pos += p.length;
    }
    return out;
  }
  decodeFrames(bytes: Uint8Array): unknown[] {
    const d = this.decoder();
    const out = d.feed(bytes);
    if (d.pendingBytes > 0) throw new RangeError("RB: truncated frame");
    return out;
  }
  /** Incremental decoder for chunked transports. */
  decoder(): { feed(chunk: Uint8Array): unknown[]; pendingBytes: number } {
    const codec = this;
    let buf = new Uint8Array(0);
    return {
      get pendingBytes() {
        return buf.length;
      },
      feed(chunk: Uint8Array): unknown[] {
        const merged = new Uint8Array(buf.length + chunk.length);
        merged.set(buf);
        merged.set(chunk, buf.length);
        buf = merged;
        const out: unknown[] = [];
        for (;;) {
          const head = readVarint(buf, 0);
          if (!head) break;
          const [len, off] = head;
          if (buf.length < off + len) break;
          // a zero-length frame is a keep-alive on an idle stream (spec 04 section 4)
          if (len > 0) out.push(codec.decode(buf.subarray(off, off + len)));
          buf = buf.slice(off + len);
        }
        return out;
      },
    };
  }
}

function varintSize(n: number): number {
  let s = 1;
  while (n >= 0x80) {
    n = Math.floor(n / 0x80);
    s++;
  }
  return s;
}
function writeVarint(out: Uint8Array, pos: number, n: number): number {
  while (n >= 0x80) {
    out[pos++] = (n % 0x80) | 0x80;
    n = Math.floor(n / 0x80);
  }
  out[pos++] = n;
  return pos;
}
function readVarint(buf: Uint8Array, pos: number): [number, number] | null {
  let n = 0;
  let mul = 1;
  for (let i = pos; i < buf.length; i++) {
    const b = buf[i]!;
    n += (b & 0x7f) * mul;
    if (b < 0x80) return [n, i + 1];
    mul *= 0x80;
  }
  return null;
}

export const RB_CONTENT_TYPE = "application/rayfold";
