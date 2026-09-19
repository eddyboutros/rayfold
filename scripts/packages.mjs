/**
 * The packages published to npm, in dependency order. Read by build.mjs, smoke-packages.mjs and publish.mjs.
 * `bin`, `copy`, `readme` and extra `exports` describe what only the published folder gets.
 */
export const PACKAGES = [
  { dir: "packages/schema" },
  { dir: "packages/rb" },
  { dir: "packages/builder" },
  { dir: "packages/server" },
  { dir: "packages/postgres" },
  { dir: "packages/otel" },
  { dir: "packages/explorer" },
  { dir: "packages/lsp" },
  { dir: "packages/client" },
  { dir: "packages/react" },
  { dir: "packages/angular" },
  { dir: "packages/cli", bin: { rayfold: "main.js" } },
  // conformance/README.md documents the fixture format for contributors; npm gets a README for users
  {
    dir: "conformance",
    copy: ["fixtures", "vectors"],
    readme: "README.npm.md",
    exports: { "./package.json": "./package.json", "./fixtures/*": "./fixtures/*", "./vectors/*": "./vectors/*" },
  },
];
