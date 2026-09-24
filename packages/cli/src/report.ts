/**
 * Findings with the text they are about.
 *
 * `validateIR` reports against a schema coordinate ("Book.price", "books()"), which is precise but leaves the author
 * to find the line. The language server already knows where every declaration sits, so `rayfold check` can show the
 * line, point at it, and - where the fix is obvious from the schema itself - say what it probably should be.
 */
import { indexDocument, rangeForPath, type Range } from "@rayfold/lsp";
import { KNOWN_ANNOTATIONS, baseName, type Diagnostic, type RayfoldSchemaIR, type TypeRef } from "@rayfold/schema";

export interface Finding {
  severity: "error" | "warning";
  code: string;
  /** The schema coordinate, or "" for a syntax error, which has nothing but a position. */
  at: string;
  message: string;
  range: Range;
}

const EMPTY: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

/** Every diagnostic, placed in the text it is about. */
export function findingsFor(text: string, diagnostics: Diagnostic[]): Finding[] {
  const index = indexDocument(text);
  return diagnostics.map((d) => ({ severity: d.severity, code: d.code, at: d.at, message: d.message, range: rangeForPath(index, d.at) }));
}

/** A syntax error knows its own position and nothing else: there is no schema to ask. */
export function syntaxFinding(error: { message: string; line?: number; col?: number }): Finding {
  const line = Math.max(0, (error.line ?? 1) - 1);
  const character = Math.max(0, (error.col ?? 1) - 1);
  return {
    severity: "error",
    code: "syntax",
    at: "",
    message: error.message,
    range: { start: { line, character }, end: { line, character: character + 1 } },
  };
}

/**
 * One finding as an author reads it:
 *
 *     error  unknown-type  Book.price: Unknown type Money
 *       --> bookstore.rayfold:12:3
 *        |
 *     12 |   price: Money
 *        |   ^^^^^
 *        = did you mean Decimal?
 */
export function renderFinding(file: string, text: string, finding: Finding, ir?: RayfoldSchemaIR): string {
  const label = finding.severity === "error" ? "error  " : "warning";
  const head = `${label}  ${finding.code}  ${finding.at ? `${finding.at}: ` : ""}${finding.message}`;
  const placed = finding.range.start.line !== finding.range.end.line || finding.range.start.character !== finding.range.end.character;
  if (!placed) return head; // nothing in the text to point at, so do not point at line 1 and mislead

  const lines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const number = finding.range.start.line + 1;
  const source = lines[finding.range.start.line] ?? "";
  const gutter = " ".repeat(String(number).length);
  const width = Math.max(1, finding.range.end.character - finding.range.start.character);
  const out = [
    head,
    `${gutter}--> ${file}:${number}:${finding.range.start.character + 1}`,
    `${gutter} |`,
    `${number} | ${source}`,
    `${gutter} | ${" ".repeat(finding.range.start.character)}${"^".repeat(width)}`,
  ];
  const fix = ir ? suggestionFor(finding, ir) : undefined;
  if (fix) out.push(`${gutter} = ${fix}`);
  return out.join("\n");
}

/** What the schema itself says the fix probably is. Nothing is suggested unless the schema makes it obvious. */
export function suggestionFor(finding: Finding, ir: RayfoldSchemaIR): string | undefined {
  const [owner, member] = split(finding.at);
  switch (finding.code) {
    case "unknown-type": {
      const missing = missingTypeAt(ir, owner, member);
      if (!missing) return undefined;
      const near = nearest(missing, Object.keys(ir.types));
      return near ? `did you mean ${near}?` : `no type named ${missing} is defined; declare it, or import the document that has it`;
    }
    case "unknown-annotation": {
      const unknown = unknownAnnotationAt(ir, owner, member);
      if (!unknown) return undefined;
      const near = nearest(unknown, Object.keys(KNOWN_ANNOTATIONS));
      return near ? `did you mean @${near}?` : `write it as @vendor.${unknown} to keep an annotation of your own`;
    }
    case "entity-id":
      return "an entity is addressed by identity: give it an `id: ID` field, or make it an `object`";
    case "reserved-name":
      return "the protocol owns that name on the wire; call the field something else";
    case "policy-this-on-op":
      return "`this` is a row; an operation has none. Put the policy on the type, or use `args` and `viewer`";
    default:
      return undefined;
  }
}

function split(at: string): [string, string | undefined] {
  // "books()" and an argument of it, "books().first", are both about the operation books
  const coordinate = at.replace(/\(\)(?=\.|$)/, "");
  const dot = coordinate.indexOf(".");
  return dot < 0 ? [coordinate, undefined] : [coordinate.slice(0, dot), coordinate.slice(dot + 1)];
}

/** The type name the coordinate points at that the schema has no definition for. */
function missingTypeAt(ir: RayfoldSchemaIR, owner: string, member: string | undefined): string | undefined {
  const refs: TypeRef[] = [];
  const op = ir.ops[owner];
  if (op) {
    refs.push(op.returns, ...op.args.map((a) => a.type));
  }
  const type = ir.types[owner];
  if (type && "fields" in type) {
    for (const f of type.fields) {
      if (member !== undefined && f.name !== member) continue;
      refs.push(f.type, ...f.args.map((a) => a.type));
    }
  }
  if (type?.kind === "union") for (const m of type.members) if (!ir.types[m]) return m;
  for (const ref of refs) {
    const name = baseName(ref);
    if (!ir.types[name]) return name;
  }
  return undefined;
}

function unknownAnnotationAt(ir: RayfoldSchemaIR, owner: string, member: string | undefined): string | undefined {
  const carriers: Array<{ annotations: Array<{ name: string }> }> = [];
  const op = ir.ops[owner];
  if (op) carriers.push(op, ...op.args);
  const type = ir.types[owner];
  if (type) {
    carriers.push(type);
    if ("fields" in type) for (const f of type.fields) if (member === undefined || f.name === member) carriers.push(f, ...f.args);
    if ("values" in type) for (const v of type.values) if (member === undefined || v.name === member) carriers.push(v);
  }
  for (const carrier of carriers) {
    for (const a of carrier.annotations) {
      if (!a.name.includes(".") && !KNOWN_ANNOTATIONS[a.name]) return a.name;
    }
  }
  return undefined;
}

/** The closest known name, when it is close enough to be a typo rather than a different word. */
export function nearest(word: string, known: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of known) {
    const d = distance(word.toLowerCase(), candidate.toLowerCase());
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  const allowed = word.length <= 4 ? 1 : word.length <= 8 ? 2 : 3;
  return best !== undefined && bestDistance <= allowed ? best : undefined;
}

function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitute = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      row.push(Math.min(substitute, previous[j]! + 1, row[j - 1]! + 1));
    }
    previous = row;
  }
  return previous[b.length]!;
}
