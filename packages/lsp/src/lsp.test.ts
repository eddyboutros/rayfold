import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import { RayfoldLanguageServer, diagnosticsFor, indexDocument, serveStdio } from "./index.ts";
import { DEF_KEYWORDS } from "./positions.ts";

const SCHEMA = [
  "entity Book @cache(maxAge: 60s, scope: public) {",
  "  id: ID",
  "  title: String",
  "  author: Author",
  "}",
  "",
  "entity Author {",
  "  id: ID",
  "  name: String",
  "}",
  "",
  "query books(first: Int): [Book] @cost(base: 5)",
].join("\n");

const URI = "file:///schema.rayfold";

/** A server with the messages it sent, so a test reads what an editor would receive. */
function server(): { server: RayfoldLanguageServer; sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  return { server: new RayfoldLanguageServer((m) => sent.push(m)), sent };
}

/** A server with one document already open, as an editor leaves it. */
function opened(text = SCHEMA): { server: RayfoldLanguageServer; sent: Array<Record<string, unknown>> } {
  const s = server();
  s.server.receive({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: URI, text } } });
  return s;
}

function request(s: RayfoldLanguageServer, sent: Array<Record<string, unknown>>, method: string, params: unknown): unknown {
  const id = sent.length + 1000;
  s.receive({ jsonrpc: "2.0", id, method, params });
  const reply = sent.find((m) => m["id"] === id);
  expect(reply, `no reply to ${method}`).toBeDefined();
  return (reply as { result: unknown }).result;
}

const diagnosticsOf = (sent: Array<Record<string, unknown>>): Array<{ message: string; code?: string; range: { start: { line: number; character: number } } }> => {
  const last = [...sent].reverse().find((m) => m["method"] === "textDocument/publishDiagnostics");
  return (last?.["params"] as { diagnostics: Array<{ message: string; code?: string; range: { start: { line: number; character: number } } }> }).diagnostics;
};

describe("the document index", () => {
  it("finds every declaration, and where it is written", () => {
    const index = indexDocument(SCHEMA);
    expect(index.declarations.filter((d) => d.kind === "type").map((d) => d.name)).toEqual(["Book", "Author"]);
    expect(index.declarations.filter((d) => d.kind === "op").map((d) => d.name)).toEqual(["books"]);
    expect(index.byPath.get("Book.title")?.range).toEqual({ start: { line: 2, character: 2 }, end: { line: 2, character: 7 } });
    // the type's range covers its whole body, so an outline can fold it
    expect(index.byPath.get("Book")?.full.end.line).toBe(4);
  });

  it("does not mistake an annotation's arguments for members", () => {
    const index = indexDocument(SCHEMA);
    expect(index.byPath.has("Book.maxAge")).toBe(false);
    expect(index.byPath.has("Book.scope")).toBe(false);
    expect(index.declarations.filter((d) => d.container === "Book").map((d) => d.name)).toEqual(["id", "title", "author"]);
  });

  it("reads enum values, and a view's name", () => {
    const index = indexDocument(["enum Status { open closed }", "entity Book { id: ID }", "view Book.card = { id }"].join("\n"));
    expect(index.declarations.filter((d) => d.kind === "enumValue").map((d) => d.path)).toEqual(["Status.open", "Status.closed"]);
    expect(index.byPath.get("Book.card")?.kind).toBe("view");
  });
});

describe("diagnostics", () => {
  it("places a validation finding on the member it is about", () => {
    const text = ["entity Book {", "  id: ID", "  price: Money", "}", "query book(id: ID): Book"].join("\n");
    const [only, ...rest] = diagnosticsFor(text);
    expect(rest).toEqual([]);
    expect(only?.code).toBe("unknown-type");
    expect(only?.severity).toBe(1);
    expect(only?.range).toEqual({ start: { line: 2, character: 2 }, end: { line: 2, character: 7 } }); // on `price`
  });

  it("reports a syntax error where the text breaks", () => {
    const [only] = diagnosticsFor(["entity Book {", "  id: ID", ""].join("\n"));
    expect(only?.message).toMatch(/Unexpected|Expected/);
    expect(only?.range.start.line).toBe(2);
  });

  it("guard - a schema that is right reports nothing", () => {
    expect(diagnosticsFor(SCHEMA)).toEqual([]);
  });

  it("publishes on open and on change, and clears on close", () => {
    const { server: s, sent } = opened();
    expect(diagnosticsOf(sent)).toEqual([]);

    s.receive({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: { textDocument: { uri: URI }, contentChanges: [{ text: SCHEMA.replace("title: String", "title: Text") }] },
    });
    expect(diagnosticsOf(sent).map((d) => d.code)).toEqual(["unknown-type"]);
    expect(diagnosticsOf(sent)[0]?.range.start).toEqual({ line: 2, character: 2 });

    s.receive({ jsonrpc: "2.0", method: "textDocument/didClose", params: { textDocument: { uri: URI } } });
    expect(diagnosticsOf(sent)).toEqual([]);
  });
});

describe("what an editor asks for", () => {
  it("offers the annotations the schema language defines, with where each one is allowed", () => {
    const { server: s, sent } = opened();
    const items = request(s, sent, "textDocument/completion", {
      textDocument: { uri: URI },
      position: { line: 0, character: 13 }, // just after the @ on the entity
    }) as Array<{ label: string; documentation: string }>;
    expect(items.map((i) => i.label)).toEqual(expect.arrayContaining(["cache", "allow", "deny", "cost", "deprecated"]));
    expect(items.find((i) => i.label === "cache")?.documentation).toContain("entity");
  });

  it("offers types where a type belongs, and keywords where a declaration belongs", () => {
    const { server: s, sent } = opened();
    const inTypePosition = request(s, sent, "textDocument/completion", {
      textDocument: { uri: URI },
      position: { line: 2, character: 9 }, // after "title:"
    }) as Array<{ label: string }>;
    expect(inTypePosition.map((i) => i.label)).toEqual(expect.arrayContaining(["Book", "Author", "String", "ID"]));

    const atTopLevel = request(s, sent, "textDocument/completion", {
      textDocument: { uri: URI },
      position: { line: 5, character: 0 },
    }) as Array<{ label: string }>;
    expect(atTopLevel.map((i) => i.label)).toEqual(expect.arrayContaining(["entity", "query", "command", "view"]));
  });

  it("shows an operation's signature on hover, and a field's type", () => {
    const { server: s, sent } = opened();
    const op = request(s, sent, "textDocument/hover", { textDocument: { uri: URI }, position: { line: 11, character: 8 } }) as {
      contents: { value: string };
    };
    expect(op.contents.value).toContain("query books(first: Int): [Book]");

    const field = request(s, sent, "textDocument/hover", { textDocument: { uri: URI }, position: { line: 3, character: 3 } }) as {
      contents: { value: string };
    };
    expect(field.contents.value).toContain("Book.author: Author");
  });

  it("jumps from a type reference to its declaration", () => {
    const { server: s, sent } = opened();
    const target = request(s, sent, "textDocument/definition", {
      textDocument: { uri: URI },
      position: { line: 3, character: 12 }, // on `Author`, where it is used
    }) as { uri: string; range: { start: { line: number; character: number } } };
    expect(target.uri).toBe(URI);
    expect(target.range.start).toEqual({ line: 6, character: 7 }); // where it is declared

    const nothing = request(s, sent, "textDocument/definition", { textDocument: { uri: URI }, position: { line: 5, character: 0 } });
    expect(nothing).toBeNull();
  });

  it("outlines the document as types with their fields, and the operations", () => {
    const { server: s, sent } = opened();
    const symbols = request(s, sent, "textDocument/documentSymbol", { textDocument: { uri: URI } }) as Array<{
      name: string;
      children: Array<{ name: string }>;
    }>;
    expect(symbols.map((x) => x.name)).toEqual(["Book", "Author", "books"]);
    expect(symbols[0]?.children.map((c) => c.name)).toEqual(["id", "title", "author"]);
    expect(symbols[2]?.children).toEqual([]);
  });

  it("answers an unknown request, and lets an unknown notification pass", () => {
    const { server: s, sent } = opened();
    s.receive({ jsonrpc: "2.0", id: 7, method: "textDocument/codeLens" });
    expect(sent.find((m) => m["id"] === 7)).toMatchObject({ error: { code: -32601 } });

    const before = sent.length;
    s.receive({ jsonrpc: "2.0", method: "workspace/didChangeWatchedFiles" });
    expect(sent.length).toBe(before);
  });

  it("works on the bookstore schema this repository ships", () => {
    const text = readFileSync(new URL("../../../examples/bookstore-ts/bookstore.rayfold", import.meta.url), "utf8");
    expect(diagnosticsFor(text).filter((d) => d.severity === 1)).toEqual([]);
    const index = indexDocument(text);
    expect(index.byPath.get("Book")?.kind).toBe("type");
    expect(index.declarations.filter((d) => d.kind === "op").length).toBeGreaterThan(3);
  });
});

describe("over stdio, as an editor speaks it", () => {
  /** Reads framed messages off the server's output; resolves as soon as [count] have arrived. */
  function reader(stream: PassThrough): (count: number) => Promise<Array<Record<string, unknown>>> {
    const messages: Array<Record<string, unknown>> = [];
    let buffer = Buffer.alloc(0);
    let waiting: { count: number; resolve: (m: Array<Record<string, unknown>>) => void } | undefined;
    stream.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const head = buffer.indexOf("\r\n\r\n");
        if (head < 0) break;
        const length = Number(/content-length:\s*(\d+)/i.exec(buffer.subarray(0, head).toString("utf8"))?.[1]);
        if (!Number.isInteger(length) || buffer.length < head + 4 + length) break;
        messages.push(JSON.parse(buffer.subarray(head + 4, head + 4 + length).toString("utf8")) as Record<string, unknown>);
        buffer = buffer.subarray(head + 4 + length);
      }
      if (waiting && messages.length >= waiting.count) {
        waiting.resolve(messages);
        waiting = undefined;
      }
    });
    return (count) =>
      new Promise((resolve) => {
        if (messages.length >= count) return resolve(messages);
        waiting = { count, resolve };
      });
  }

  const frame = (message: unknown): Buffer => {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"), body]);
  };

  it("initializes, then underlines what the schema gets wrong", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    serveStdio(input, output);
    const read = reader(output);

    input.write(frame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } }));
    input.write(
      frame({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: { textDocument: { uri: URI, text: ["entity Book {", "  id: ID", "  price: Money", "}", "query book(id: ID): Book"].join("\n") } },
      }),
    );

    const messages = await read(2);
    expect((messages[0] as { result: { capabilities: Record<string, unknown> } }).result.capabilities).toMatchObject({
      hoverProvider: true,
      definitionProvider: true,
      documentSymbolProvider: true,
    });
    const published = messages[1] as { method: string; params: { uri: string; diagnostics: Array<{ code: string }> } };
    expect(published.method).toBe("textDocument/publishDiagnostics");
    expect(published.params.uri).toBe(URI);
    expect(published.params.diagnostics.map((d) => d.code)).toEqual(["unknown-type"]);
  });

  it("reads two messages that arrive in one chunk, and one split across chunks", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    serveStdio(input, output);
    const read = reader(output);

    input.write(Buffer.concat([frame({ jsonrpc: "2.0", id: 1, method: "initialize" }), frame({ jsonrpc: "2.0", id: 2, method: "shutdown" })]));
    const both = await read(2);
    expect(both.map((m) => m["id"])).toEqual([1, 2]);

    const split = frame({ jsonrpc: "2.0", id: 3, method: "initialize" });
    input.write(split.subarray(0, 20));
    input.write(split.subarray(20));
    const all = await read(3);
    expect(all[2]?.["id"]).toBe(3);
  });

  it("stops when the editor says exit, and when the pipe closes", async () => {
    const stopped: string[] = [];

    const told = new PassThrough();
    serveStdio(told, new PassThrough(), { onExit: () => stopped.push("exit") });
    told.write(frame({ jsonrpc: "2.0", method: "exit" }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toEqual(["exit"]);

    const closed = new PassThrough();
    serveStdio(closed, new PassThrough(), { onExit: () => stopped.push("closed") });
    closed.end();
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toEqual(["exit", "closed"]);
  });

  it("guard - it keeps serving while the editor is still talking", async () => {
    const stopped: string[] = [];
    const input = new PassThrough();
    const output = new PassThrough();
    serveStdio(input, output, { onExit: () => stopped.push("exit") });
    const read = reader(output);

    input.write(frame({ jsonrpc: "2.0", id: 1, method: "initialize" }));
    await read(1);
    expect(stopped).toEqual([]);
  });
});

describe("the editor assets this repository ships", () => {
  const asset = (path: string): string => readFileSync(new URL(`../../../editors/vscode/${path}`, import.meta.url), "utf8");

  it("the grammar parses, and covers every declaration the language has", () => {
    const grammar = JSON.parse(asset("syntaxes/rayfold.tmLanguage.json")) as {
      scopeName: string;
      repository: { keywords: { patterns: Array<{ match: string }> } };
    };
    expect(grammar.scopeName).toBe("source.rayfold");
    const declarations = grammar.repository.keywords.patterns[0]?.match ?? "";
    for (const keyword of DEF_KEYWORDS) expect(declarations).toContain(keyword);
  });

  it("the language configuration parses, and claims the extension", () => {
    expect(JSON.parse(asset("language-configuration.json"))).toHaveProperty("comments.lineComment", "//");
    const manifest = JSON.parse(asset("package.json")) as { contributes: { languages: Array<{ extensions: string[] }> } };
    expect(manifest.contributes.languages[0]?.extensions).toEqual([".rayfold"]);
  });
});
