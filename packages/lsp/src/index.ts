/**
 * A language server for `.rayfold` documents: diagnostics as you type, completion for keywords, annotations and type
 * names, hover, go to definition, and an outline.
 *
 * The protocol handling is transport-free. [RayfoldLanguageServer] takes the messages an editor sends and calls back
 * with the messages to send, so the same object serves over stdio (`rayfold lsp`) or any other channel, and a test
 * can drive it without a process.
 */
import {
  BUILTIN_SCALARS,
  KNOWN_ANNOTATIONS,
  RayfoldSyntaxError,
  parseSchemaText,
  typeRefToString,
  validateIR,
  type RayfoldSchemaIR,
} from "@rayfold/schema";
import { DEF_KEYWORDS, declarationAt, indexDocument, rangeForPath, tokenAt, type Position, type Range } from "./positions.ts";

export { declarationAt, indexDocument, rangeForPath, tokenAt, type Declaration, type DocumentIndex, type Position, type Range } from "./positions.ts";

export interface IncomingMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

export type Send = (message: Record<string, unknown>) => void;

/** Severity as the protocol numbers it. */
const ERROR = 1;
const WARNING = 2;

/** SymbolKind as the protocol numbers it. */
const SYMBOL = { field: 8, function: 12, property: 7, enumMember: 22, struct: 23 } as const;

/** CompletionItemKind as the protocol numbers it. */
const COMPLETION = { keyword: 14, class: 7, property: 10, value: 12 } as const;

const CAPABILITIES = {
  textDocumentSync: 1, // full text on every change: a schema is small, and a full parse is what validation needs
  completionProvider: { triggerCharacters: ["@", ":", "<", "|"] },
  hoverProvider: true,
  definitionProvider: true,
  documentSymbolProvider: true,
};

const isIdentifier = (c: string): boolean => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_";

/** The word being typed, and the punctuation that introduced it. */
function wordBefore(line: string, character: number): { word: string; trigger: string } {
  const end = Math.min(character, line.length);
  let start = end;
  while (start > 0 && isIdentifier(line[start - 1]!)) start--;
  let before = start;
  while (before > 0 && (line[before - 1] === " " || line[before - 1] === "\t")) before--;
  return { word: line.slice(start, end), trigger: before > 0 ? line[before - 1]! : "" };
}

const lines = (text: string): string[] => text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));

export class RayfoldLanguageServer {
  private readonly documents = new Map<string, string>();

  /** [onExit] runs when the editor sends `exit`, so whatever hosts the server can stop with it. */
  constructor(
    private readonly send: Send,
    private readonly onExit?: () => void,
  ) {}

  /** One message from the editor. Responses and notifications go back through the send given to the constructor. */
  receive(message: IncomingMessage): void {
    const id = message.id;
    switch (message.method) {
      case "initialize":
        return this.reply(id, { capabilities: CAPABILITIES, serverInfo: { name: "rayfold", version: "0.1" } });
      case "initialized":
      case "$/cancelRequest":
        return;
      case "exit":
        this.onExit?.();
        return;
      case "shutdown":
        return this.reply(id, null);
      case "textDocument/didOpen": {
        const p = params<{ textDocument: { uri: string; text: string } }>(message);
        this.documents.set(p.textDocument.uri, p.textDocument.text);
        return this.publish(p.textDocument.uri);
      }
      case "textDocument/didChange": {
        const p = params<{ textDocument: { uri: string }; contentChanges: Array<{ text: string }> }>(message);
        const last = p.contentChanges[p.contentChanges.length - 1];
        if (!last) return;
        this.documents.set(p.textDocument.uri, last.text);
        return this.publish(p.textDocument.uri);
      }
      case "textDocument/didClose": {
        const p = params<{ textDocument: { uri: string } }>(message);
        this.documents.delete(p.textDocument.uri);
        this.send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: p.textDocument.uri, diagnostics: [] } });
        return;
      }
      case "textDocument/completion": {
        const p = params<TextDocumentPosition>(message);
        return this.reply(id, this.completion(p.textDocument.uri, p.position));
      }
      case "textDocument/hover": {
        const p = params<TextDocumentPosition>(message);
        return this.reply(id, this.hover(p.textDocument.uri, p.position));
      }
      case "textDocument/definition": {
        const p = params<TextDocumentPosition>(message);
        return this.reply(id, this.definition(p.textDocument.uri, p.position));
      }
      case "textDocument/documentSymbol": {
        const p = params<{ textDocument: { uri: string } }>(message);
        return this.reply(id, this.symbols(p.textDocument.uri));
      }
      default:
        // a notification we do not know is ignored; a request always gets an answer
        if (id !== undefined && id !== null) {
          this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${String(message.method)}` } });
        }
    }
  }

  /** The text the editor last sent for [uri], for a caller that keeps its own view of the workspace. */
  document(uri: string): string | undefined {
    return this.documents.get(uri);
  }

  private reply(id: number | string | null | undefined, result: unknown): void {
    if (id === undefined || id === null) return;
    this.send({ jsonrpc: "2.0", id, result });
  }

  private publish(uri: string): void {
    const text = this.documents.get(uri) ?? "";
    this.send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: diagnosticsFor(text) } });
  }

  private completion(uri: string, position: Position): unknown[] {
    const text = this.documents.get(uri);
    if (text === undefined) return [];
    const line = lines(text)[position.line] ?? "";
    const { trigger } = wordBefore(line, position.character);
    const index = indexDocument(text);

    if (trigger === "@") {
      return Object.entries(KNOWN_ANNOTATIONS).map(([name, on]) => ({
        label: name,
        kind: COMPLETION.property,
        detail: `@${name}`,
        documentation: `Allowed on: ${[...on].join(", ")}.`,
      }));
    }

    const types = index.declarations
      .filter((d) => d.kind === "type")
      .map((d) => ({ label: d.name, kind: COMPLETION.class, detail: d.keyword }));

    if (trigger === ":" || trigger === "<" || trigger === "|" || trigger === ",") {
      const builtins = BUILTIN_SCALARS.map((name) => ({ label: name, kind: COMPLETION.value, detail: "scalar" }));
      return [...types, ...builtins];
    }

    const keywords = DEF_KEYWORDS.map((word) => ({ label: word, kind: COMPLETION.keyword, detail: "declaration" }));
    return [...keywords, ...types];
  }

  private hover(uri: string, position: Position): unknown {
    const text = this.documents.get(uri);
    if (text === undefined) return null;
    const index = indexDocument(text);
    const token = tokenAt(index, position);
    const declaration = declarationAt(index, position) ?? (token?.kind === "name" ? index.byPath.get(token.value) : undefined);
    if (!declaration) return null;

    const ir = irOf(text);
    const body: string[] = [];
    if (declaration.kind === "op") {
      const op = ir?.ops[declaration.name];
      const signature = op
        ? `${op.kind} ${op.name}(${op.args.map((a) => `${a.name}: ${typeRefToString(a.type)}`).join(", ")}): ${typeRefToString(op.returns)}`
        : `${declaration.keyword} ${declaration.name}`;
      body.push(code(signature));
      if (op?.description) body.push(op.description);
      if (op?.throws.length) body.push(`Fails with: ${op.throws.join(", ")}.`);
      if (op?.emits.length) body.push(`Emits: ${op.emits.join(", ")}.`);
    } else if (declaration.kind === "field" || declaration.kind === "enumValue") {
      const owner = declaration.container ? ir?.types[declaration.container] : undefined;
      const field = owner && "fields" in owner ? owner.fields.find((f) => f.name === declaration.name) : undefined;
      body.push(code(field ? `${declaration.path}: ${typeRefToString(field.type)}` : declaration.path));
      if (field?.description) body.push(field.description);
      const annotations = field?.annotations.map((a) => `@${a.name}`) ?? [];
      if (annotations.length) body.push(annotations.join(" "));
    } else {
      const type = ir?.types[declaration.name];
      body.push(code(`${declaration.keyword} ${declaration.name}`));
      if (type?.description) body.push(type.description);
      const annotations = type?.annotations.map((a) => `@${a.name}`) ?? [];
      if (annotations.length) body.push(annotations.join(" "));
    }
    return { contents: { kind: "markdown", value: body.join("\n\n") }, range: declaration.range };
  }

  private definition(uri: string, position: Position): unknown {
    const text = this.documents.get(uri);
    if (text === undefined) return null;
    const index = indexDocument(text);
    const token = tokenAt(index, position);
    if (!token || token.kind !== "name") return null;
    const declaration = index.byPath.get(token.value) ?? declarationAt(index, position);
    return declaration ? { uri, range: declaration.range } : null;
  }

  private symbols(uri: string): unknown[] {
    const text = this.documents.get(uri);
    if (text === undefined) return [];
    const index = indexDocument(text);
    const children = new Map<string, unknown[]>();
    for (const d of index.declarations) {
      if (!d.container) continue;
      const kind = d.kind === "enumValue" ? SYMBOL.enumMember : d.kind === "view" ? SYMBOL.property : SYMBOL.field;
      const list = children.get(d.container) ?? [];
      list.push({ name: d.name, detail: d.keyword, kind, range: d.full, selectionRange: d.range });
      children.set(d.container, list);
    }
    return index.declarations
      .filter((d) => !d.container)
      .map((d) => ({
        name: d.name,
        detail: d.keyword,
        kind: d.kind === "op" ? SYMBOL.function : SYMBOL.struct,
        range: d.full,
        selectionRange: d.range,
        children: children.get(d.name) ?? [],
      }));
  }
}

interface TextDocumentPosition {
  textDocument: { uri: string };
  position: Position;
}

const params = <T>(message: IncomingMessage): T => (message.params ?? {}) as T;

const code = (text: string): string => ["```rayfold", text, "```"].join("\n");

function irOf(text: string): RayfoldSchemaIR | undefined {
  try {
    return parseSchemaText(text);
  } catch {
    return undefined;
  }
}

/** What the editor underlines: the syntax error, or every finding validation reports, placed in the text. */
export function diagnosticsFor(text: string): Array<{ range: Range; severity: number; code?: string; source: string; message: string }> {
  let ir: RayfoldSchemaIR;
  try {
    ir = parseSchemaText(text);
  } catch (e) {
    const start: Position =
      e instanceof RayfoldSyntaxError ? { line: Math.max(0, e.line - 1), character: Math.max(0, e.col - 1) } : { line: 0, character: 0 };
    return [{ range: { start, end: start }, severity: ERROR, source: "rayfold", message: (e as Error).message }];
  }
  const index = indexDocument(text);
  return validateIR(ir).map((d) => ({
    range: rangeForPath(index, d.at),
    severity: d.severity === "error" ? ERROR : WARNING,
    code: d.code,
    source: "rayfold",
    message: d.message,
  }));
}

/**
 * The server over a stream pair, framed as the protocol asks (`Content-Length`, then the JSON). `rayfold lsp` runs
 * this on the process's own stdin and stdout.
 */
export function serveStdio(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  options: { onExit?: () => void } = {},
): RayfoldLanguageServer {
  const server = new RayfoldLanguageServer((message) => {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    output.write(`Content-Length: ${body.length}\r\n\r\n`);
    output.write(body);
  }, options.onExit);

  let buffer = Buffer.alloc(0);
  input.on("data", (chunk: Buffer | string) => {
    buffer = Buffer.concat([buffer, typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const length = contentLength(header);
      if (length === undefined) {
        buffer = buffer.subarray(headerEnd + 4); // a header we cannot read: drop it rather than stall the stream
        continue;
      }
      const start = headerEnd + 4;
      if (buffer.length < start + length) return;
      const body = buffer.subarray(start, start + length).toString("utf8");
      buffer = buffer.subarray(start + length);
      let message: IncomingMessage;
      try {
        message = JSON.parse(body) as IncomingMessage;
      } catch {
        continue; // not our message to answer: there is no id to answer it with
      }
      server.receive(message);
    }
  });
  input.on("end", () => options.onExit?.()); // the editor closed the pipe: there is nothing left to serve
  return server;
}

function contentLength(header: string): number | undefined {
  for (const line of header.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    if (line.slice(0, colon).trim().toLowerCase() !== "content-length") continue;
    const value = Number(line.slice(colon + 1).trim());
    if (Number.isInteger(value) && value >= 0) return value;
  }
  return undefined;
}
