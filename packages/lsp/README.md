# @rayfold/lsp

A language server for [Rayfold](https://github.com/eddyboutros/rayfold) schemas. It reads `.rayfold` documents with the
same parser and validator the runtime uses, so what an editor underlines is what `rayfold check` would report, in the
same words.

```sh
npm install --save-dev @rayfold/lsp @rayfold/cli
rayfold lsp        # speaks LSP over stdin and stdout
```

What it answers:

| Request | What you get |
| --- | --- |
| diagnostics | every syntax error and every validation finding, placed on the declaration it is about |
| completion | declaration keywords, annotations (with where each one is allowed), and type names in a type position |
| hover | the declaration, its description and its annotations; an operation shows its signature, what it throws and what it emits |
| definition | jump from a type reference to its declaration |
| document symbols | an outline of types with their fields, and the operations |

The server holds no dependencies of its own beyond `@rayfold/schema`, and speaks the protocol's `Content-Length`
framing directly, so it runs anywhere Node does.

## Without the CLI

`serveStdio` puts it on any stream pair, and `RayfoldLanguageServer` is transport-free if you have a channel of your
own:

```ts
import { serveStdio } from "@rayfold/lsp";

serveStdio(process.stdin, process.stdout);
```

`diagnosticsFor(text)` returns the same findings as a plain function, for a check that is not an editor.

Editor setup, including a TextMate grammar for highlighting, is in the [editor guide](../../docs/guide/editors.md).

Apache-2.0.
