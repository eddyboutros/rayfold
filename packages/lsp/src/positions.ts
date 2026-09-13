/**
 * Where each declaration sits in a `.rayfold` document.
 *
 * The IR carries no source positions, and `validateIR` reports its findings against paths ("Book.price", "books()").
 * This walks the same token stream the parser reads and records a range for every declaration, so a diagnostic, a
 * hover or a go-to-definition can be answered in the text the author is looking at.
 */
import { tokenize, type Token } from "@rayfold/schema";

/** LSP positions are zero-based; the lexer's are one-based. */
export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export type DeclarationKind = "type" | "field" | "op" | "enumValue" | "view";

export interface Declaration {
  /** "Book", "Book.title", "books" - the path `validateIR` reports against, without the trailing (). */
  path: string;
  name: string;
  kind: DeclarationKind;
  /** what the source calls it: entity, object, query, command, ... */
  keyword: string;
  container?: string;
  /** the identifier itself, for a selection or a jump */
  range: Range;
  /** the whole declaration, for an outline */
  full: Range;
}

export interface DocumentIndex {
  tokens: Token[];
  declarations: Declaration[];
  byPath: Map<string, Declaration>;
}

export const TYPE_KEYWORDS = ["entity", "object", "input", "enum", "union", "scalar", "error", "event"] as const;
export const OP_KEYWORDS = ["query", "command", "stream"] as const;
export const DEF_KEYWORDS = [...TYPE_KEYWORDS, ...OP_KEYWORDS, "view"] as const;

const TYPES = new Set<string>(TYPE_KEYWORDS);
const OPS = new Set<string>(OP_KEYWORDS);
const DEFS = new Set<string>(DEF_KEYWORDS);

const startOf = (t: Token): Position => ({ line: t.line - 1, character: t.col - 1 });
const rangeOf = (t: Token): Range => ({ start: startOf(t), end: { line: t.line - 1, character: t.col - 1 + t.value.length } });

/** True when [position] falls inside [range], counting both ends so a cursor at either edge of a word still hits it. */
export function contains(range: Range, position: Position): boolean {
  if (position.line < range.start.line || position.line > range.end.line) return false;
  if (position.line === range.start.line && position.character < range.start.character) return false;
  if (position.line === range.end.line && position.character > range.end.character) return false;
  return true;
}

/**
 * Every declaration in [text]. A document that cannot be tokenized at all (an unterminated string, say) indexes as
 * empty: the syntax error is reported on its own, and half a token stream would only misplace things.
 */
export function indexDocument(text: string): DocumentIndex {
  let tokens: Token[];
  try {
    tokens = tokenize(text);
  } catch {
    tokens = [];
  }

  const declarations: Declaration[] = [];
  let depth = 0; // brace depth, counted only outside argument lists
  let paren = 0;
  let container: Declaration | undefined; // the type whose body we are in
  let pending: Declaration | undefined; // a type declaration waiting for its body
  let openOp: Declaration | undefined; // an operation, which has no body to close it
  let afterAt = false;
  let previous: Token | undefined;

  const closeOp = (end: Token | undefined): void => {
    if (openOp && end) openOp.full = { start: openOp.full.start, end: rangeOf(end).end };
    openOp = undefined;
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === "eof") break;
    const next = tokens[i + 1];

    if (t.kind === "punct") {
      if (t.value === "@") {
        afterAt = true;
        previous = t;
        continue;
      }
      if (paren === 0 && t.value === "{") {
        depth++;
        if (depth === 1 && pending) {
          container = pending;
          pending = undefined;
        }
      } else if (paren === 0 && t.value === "}") {
        depth--;
        if (depth <= 0) {
          depth = 0;
          if (container) container.full = { start: container.full.start, end: rangeOf(t).end };
          container = undefined;
        }
      } else if (t.value === "(") {
        paren++;
      } else if (t.value === ")") {
        paren = Math.max(0, paren - 1);
      }
      afterAt = false;
      previous = t;
      continue;
    }

    if (afterAt) {
      afterAt = false; // the annotation's own name, not a member
      previous = t;
      continue;
    }

    if (t.kind === "name" && depth === 0 && paren === 0 && DEFS.has(t.value)) {
      closeOp(previous);
      if (t.value === "view") {
        const owner = next;
        const dot = tokens[i + 2];
        const member = tokens[i + 3];
        if (owner?.kind === "name" && dot?.kind === "punct" && dot.value === "." && member?.kind === "name") {
          declarations.push({
            path: `${owner.value}.${member.value}`,
            name: member.value,
            kind: "view",
            keyword: "view",
            container: owner.value,
            range: rangeOf(member),
            full: { start: startOf(t), end: rangeOf(member).end },
          });
        }
        previous = t;
        continue;
      }
      if (next?.kind === "name") {
        const declaration: Declaration = {
          path: next.value,
          name: next.value,
          kind: OPS.has(t.value) ? "op" : "type",
          keyword: t.value,
          range: rangeOf(next),
          full: { start: startOf(t), end: rangeOf(next).end },
        };
        declarations.push(declaration);
        if (TYPES.has(t.value)) pending = declaration;
        else openOp = declaration;
      }
      previous = t;
      continue;
    }

    if (t.kind === "name" && depth === 1 && paren === 0 && container) {
      const member = next?.kind === "punct" && (next.value === ":" || next.value === "(");
      if (member || container.keyword === "enum") {
        declarations.push({
          path: `${container.name}.${t.value}`,
          name: t.value,
          kind: member ? "field" : "enumValue",
          keyword: member ? "field" : "value",
          container: container.name,
          range: rangeOf(t),
          full: rangeOf(t),
        });
      }
    }
    previous = t;
  }
  closeOp(previous);

  const byPath = new Map<string, Declaration>();
  for (const d of declarations) if (!byPath.has(d.path)) byPath.set(d.path, d);
  return { tokens, declarations, byPath };
}

/** The declaration whose identifier is under [position]. */
export function declarationAt(index: DocumentIndex, position: Position): Declaration | undefined {
  return index.declarations.find((d) => contains(d.range, position));
}

/** The token under [position], which is what a hover or a completion is about. */
export function tokenAt(index: DocumentIndex, position: Position): Token | undefined {
  return index.tokens.find((t) => t.kind !== "eof" && contains(rangeOf(t), position));
}

/** Where a `validateIR` diagnostic belongs in the text; the first line when the path names nothing we found. */
export function rangeForPath(index: DocumentIndex, path: string): Range {
  const declaration = index.byPath.get(path.endsWith("()") ? path.slice(0, -2) : path);
  if (declaration) return declaration.range;
  const owner = path.split(".")[0];
  const type = owner ? index.byPath.get(owner) : undefined;
  if (type) return type.range;
  return { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
}
