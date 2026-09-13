# Editors

`.rayfold` is a language, so it gets what a language gets: errors as you type, completion, hover, go to definition and
an outline. `@rayfold/lsp` is a language server that reads a schema with the same parser and validator the runtime
uses, so what an editor underlines is what `rayfold check` reports, in the same words.

```sh
npm install --save-dev @rayfold/cli @rayfold/lsp
npx rayfold lsp        # speaks the protocol over stdin and stdout
```

| What you ask | What you get |
| --- | --- |
| errors as you type | every syntax error, and every validation finding placed on the declaration it is about |
| completion | declaration keywords; annotations, each with where it is allowed; type names in a type position |
| hover | the declaration, its description and its annotations; an operation shows its signature, what it throws and what it emits |
| go to definition | from a type reference to its declaration |
| outline | types with their fields, and the operations |

## Visual Studio Code

`editors/vscode` in this repository is a small extension with the language's grammar: highlighting, comments and
brackets for `.rayfold`. Copy it into `~/.vscode/extensions` (or open it and press F5 to run it in a second window).

To get the diagnostics and the rest, start the server from an extension of your own with
[vscode-languageclient](https://www.npmjs.com/package/vscode-languageclient):

```js
const { LanguageClient, TransportKind } = require("vscode-languageclient/node");

const client = new LanguageClient(
  "rayfold",
  "Rayfold",
  { command: "npx", args: ["rayfold", "lsp"], transport: TransportKind.stdio },
  { documentSelector: [{ scheme: "file", language: "rayfold" }] },
);
client.start();
```

## Neovim

```lua
vim.filetype.add({ extension = { rayfold = "rayfold" } })
vim.api.nvim_create_autocmd("FileType", {
  pattern = "rayfold",
  callback = function()
    vim.lsp.start({ name = "rayfold", cmd = { "npx", "rayfold", "lsp" }, root_dir = vim.fn.getcwd() })
  end,
})
```

## Anything else

Any editor that speaks LSP over stdio works: the command is `rayfold lsp`, and the server needs nothing else. In a
program of your own, `diagnosticsFor(text)` from `@rayfold/lsp` returns the same findings as a plain function, and
`RayfoldLanguageServer` takes the protocol's messages directly if you have a channel that is not a pipe.
