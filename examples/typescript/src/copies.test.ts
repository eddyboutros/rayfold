/**
 * Every example serves the same bookshop, so the website can show the stacks side by side. A copy that drifts from
 * the others fails here.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const examples = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

function find(dir: string, name: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return ["node_modules", "build", "target", ".gradle", "dist"].includes(e.name) ? [] : find(join(dir, e.name), name);
    return e.name === name ? [join(dir, e.name)] : [];
  });
}

it("every example has the same bookshop schema", () => {
  const copies = find(examples, "bookshop.rayfold");
  const stacks = new Set(copies.map((p) => relative(examples, p).split(/[\\/]/)[0]));
  expect([...stacks].sort()).toEqual(["java", "kotlin", "react", "spring-boot", "typescript"]);

  const original = read(join(examples, "typescript", "src", "bookshop.rayfold"));
  for (const copy of copies) expect(read(copy), relative(examples, copy)).toBe(original);
});

it("the React app's server runs the TypeScript example's resolvers", () => {
  expect(read(join(examples, "react", "src", "resolvers.ts"))).toBe(read(join(examples, "typescript", "src", "resolvers.ts")));
});
