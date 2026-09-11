import { sha256Hex } from "./sha256.ts";

export { sha256Hex };

/** Canonical JSON: sorted keys, no whitespace, undefined dropped (spec/01-schema.md §9). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (value === undefined) return "null";
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Non-finite number in canonical JSON");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function hashJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/** Sextet per ASCII code, -1 outside the alphabet. `+` and `/` decode too, as they do with Buffer's "base64url". */
const SEXTET = (() => {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < 64; i++) t[B64URL.charCodeAt(i)] = i;
  t[43] = 62;
  t[47] = 63;
  return t;
})();
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** Unpadded base64url of the UTF-8 bytes of [text]; the same output as Buffer's "base64url". */
export function base64url(text: string): string {
  const b = utf8Encoder.encode(text);
  let out = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i]! << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]!;
    if (i + 1 < b.length) out += B64URL[(n >> 6) & 63]!;
    if (i + 2 < b.length) out += B64URL[n & 63]!;
  }
  return out;
}

/** Text from base64url (or base64), decoded as Buffer does: characters outside the alphabet are skipped and `=` ends the data. */
export function fromBase64url(b64: string): string {
  const out = new Uint8Array(Math.floor((b64.length * 3) / 4) + 1);
  let len = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < b64.length; i++) {
    const c = b64.charCodeAt(i);
    if (c === 61) break;
    const v = c < 128 ? SEXTET[c]! : -1;
    if (v < 0) continue;
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[len++] = (acc >> bits) & 0xff;
    }
  }
  return utf8Decoder.decode(out.subarray(0, len));
}
