/** Tokenizer shared by the .rayfold parser, the shape parser and the policy-expression parser. */

export type TokenKind =
  | "name"
  | "int"
  | "float"
  | "string"
  | "blockstring"
  | "duration"
  | "punct"
  | "eof";

export interface Token {
  kind: TokenKind;
  value: string;
  /** numeric value for int/float, milliseconds for duration */
  num?: number;
  line: number;
  col: number;
  offset: number;
}

export class RayfoldSyntaxError extends Error {
  constructor(
    message: string,
    public readonly line: number,
    public readonly col: number,
  ) {
    super(`${message} (${line}:${col})`);
    this.name = "RayfoldSyntaxError";
  }
}

const PUNCT3 = ["..."];
const PUNCT2 = ["==", "!=", "<=", ">=", "&&", "||"];
const PUNCT1 = "{}()[]:=,.<>|?@!$";

const DURATION_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const n = src.length;

  const push = (kind: TokenKind, value: string, start: number, num?: number) => {
    const t: Token = { kind, value, line, col: start - lineStart + 1, offset: start };
    if (num !== undefined) t.num = num;
    out.push(t);
  };
  // 1e999 reads as Infinity, which JSON cannot carry: refuse it here so it never reaches the IR
  const finite = (num: number, text: string, start: number): number => {
    if (!Number.isFinite(num)) throw new RayfoldSyntaxError(`Number out of range: ${text}`, line, start - lineStart + 1);
    return num;
  };

  while (i < n) {
    const c = src[i]!;
    if (c === "\n") {
      line++;
      i++;
      lineStart = i;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === ",") {
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) throw new RayfoldSyntaxError("Unterminated block comment", line, i - lineStart + 1);
      for (let j = i; j < end; j++) {
        if (src[j] === "\n") {
          line++;
          lineStart = j + 1;
        }
      }
      i = end + 2;
      continue;
    }
    if (src.startsWith('"""', i)) {
      const start = i;
      const end = src.indexOf('"""', i + 3);
      if (end < 0) throw new RayfoldSyntaxError("Unterminated block string", line, i - lineStart + 1);
      const raw = src.slice(i + 3, end);
      push("blockstring", dedent(raw), start);
      for (let j = i; j < end + 3; j++) {
        if (src[j] === "\n") {
          line++;
          lineStart = j + 1;
        }
      }
      i = end + 3;
      continue;
    }
    if (c === '"') {
      const start = i;
      i++;
      let s = "";
      while (i < n && src[i] !== '"') {
        const ch = src[i]!;
        if (ch === "\n") throw new RayfoldSyntaxError("Unterminated string", line, start - lineStart + 1);
        if (ch === "\\") {
          const e = src[i + 1];
          i += 2;
          switch (e) {
            case "n": s += "\n"; break;
            case "t": s += "\t"; break;
            case "r": s += "\r"; break;
            case '"': s += '"'; break;
            case "\\": s += "\\"; break;
            case "/": s += "/"; break;
            case "b": s += "\b"; break;
            case "f": s += "\f"; break;
            case "u": {
              const hex = src.slice(i, i + 4);
              if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new RayfoldSyntaxError("Bad unicode escape", line, i - lineStart + 1);
              s += String.fromCharCode(parseInt(hex, 16));
              i += 4;
              break;
            }
            default:
              throw new RayfoldSyntaxError(`Bad escape \\${e ?? ""}`, line, i - lineStart + 1);
          }
          continue;
        }
        s += ch;
        i++;
      }
      if (i >= n) throw new RayfoldSyntaxError("Unterminated string", line, start - lineStart + 1);
      i++;
      push("string", s, start);
      continue;
    }
    if (isDigit(c) || (c === "-" && isDigit(src[i + 1] ?? ""))) {
      const start = i;
      i++;
      while (i < n && isDigit(src[i]!)) i++;
      let isFloat = false;
      if (src[i] === "." && isDigit(src[i + 1] ?? "")) {
        isFloat = true;
        i++;
        while (i < n && isDigit(src[i]!)) i++;
      }
      if (src[i] === "e" || src[i] === "E") {
        const save = i;
        i++;
        if (src[i] === "+" || src[i] === "-") i++;
        if (isDigit(src[i] ?? "")) {
          isFloat = true;
          while (i < n && isDigit(src[i]!)) i++;
        } else i = save;
      }
      const text = src.slice(start, i);
      // duration suffix
      const m = /^(ms|s|m|h|d)(?![A-Za-z0-9_])/.exec(src.slice(i, i + 3));
      if (m && !isFloat) {
        const unit = m[1]!;
        i += unit.length;
        push("duration", text + unit, start, finite(Number(text) * DURATION_UNITS[unit]!, text + unit, start));
        continue;
      }
      push(isFloat ? "float" : "int", text, start, finite(Number(text), text, start));
      continue;
    }
    if (isNameStart(c)) {
      const start = i;
      i++;
      while (i < n && isNameChar(src[i]!)) i++;
      push("name", src.slice(start, i), start);
      continue;
    }
    const three = src.slice(i, i + 3);
    if (PUNCT3.includes(three)) {
      push("punct", three, i);
      i += 3;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (PUNCT2.includes(two)) {
      push("punct", two, i);
      i += 2;
      continue;
    }
    if (PUNCT1.includes(c)) {
      push("punct", c, i);
      i++;
      continue;
    }
    throw new RayfoldSyntaxError(`Unexpected character ${JSON.stringify(c)}`, line, i - lineStart + 1);
  }
  out.push({ kind: "eof", value: "", line, col: i - lineStart + 1, offset: i });
  return out;
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}
function isNameStart(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
}
function isNameChar(c: string): boolean {
  return isNameStart(c) || isDigit(c);
}

/** GraphQL-style block string dedent: strip common indentation and leading/trailing blank lines. */
function dedent(raw: string): string {
  const lines = raw.split(/\r?\n/);
  let common: number | null = null;
  for (const l of lines.slice(1)) {
    const indent = l.length - l.trimStart().length;
    if (l.trim().length === 0) continue;
    if (common === null || indent < common) common = indent;
  }
  const out = lines.map((l, idx) => (idx === 0 || common === null ? l : l.slice(Math.min(common, l.length - l.trimStart().length))));
  while (out.length && out[0]!.trim() === "") out.shift();
  while (out.length && out[out.length - 1]!.trim() === "") out.pop();
  return out.join("\n").trim();
}

/** Cursor over a token array with the small helpers every parser needs. */
export class TokenStream {
  pos = 0;
  constructor(public readonly tokens: Token[]) {}

  peek(ahead = 0): Token {
    return this.tokens[Math.min(this.pos + ahead, this.tokens.length - 1)]!;
  }
  next(): Token {
    const t = this.peek();
    if (t.kind !== "eof") this.pos++;
    return t;
  }
  at(kind: TokenKind, value?: string): boolean {
    const t = this.peek();
    return t.kind === kind && (value === undefined || t.value === value);
  }
  atPunct(value: string): boolean {
    return this.at("punct", value);
  }
  atName(value?: string): boolean {
    return this.at("name", value);
  }
  accept(kind: TokenKind, value?: string): Token | null {
    return this.at(kind, value) ? this.next() : null;
  }
  expect(kind: TokenKind, value?: string): Token {
    const t = this.peek();
    if (!this.at(kind, value)) {
      const want = value !== undefined ? JSON.stringify(value) : kind;
      const got = t.kind === "eof" ? "end of input" : JSON.stringify(t.value);
      throw new RayfoldSyntaxError(`Expected ${want} but found ${got}`, t.line, t.col);
    }
    return this.next();
  }
  expectPunct(value: string): Token {
    return this.expect("punct", value);
  }
  expectName(): string {
    return this.expect("name").value;
  }
  error(message: string, t: Token = this.peek()): RayfoldSyntaxError {
    return new RayfoldSyntaxError(message, t.line, t.col);
  }
}
