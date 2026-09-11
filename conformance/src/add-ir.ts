/** Embed the parsed IR into every fixture so runtimes without a .rayfold parser (Kotlin) can run them. */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSchema } from "@rayfold/schema";

const root = fileURLToPath(new URL("../fixtures", import.meta.url));
let n = 0;
for (const profile of readdirSync(root)) {
  const dir = join(root, profile);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const path = join(dir, file);
    const fx = JSON.parse(readFileSync(path, "utf8")) as { schema: string; ir?: unknown; cases: unknown[]; name: string; data: unknown; resolvers: unknown; options?: unknown };
    const ir = loadSchema(fx.schema).ir;
    const ordered = { name: fx.name, schema: fx.schema, ir, data: fx.data, resolvers: fx.resolvers, ...(fx.options ? { options: fx.options } : {}), cases: fx.cases };
    writeFileSync(path, JSON.stringify(ordered, null, 2) + "\n");
    n++;
  }
}
console.log(`embedded IR into ${n} fixtures`);
