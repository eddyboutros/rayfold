// Design decisions from spec/adr at the root of the repository.
import { readFileSync } from "node:fs";
import { basename } from "node:path";

export default {
  watch: ["../../../spec/adr/*.md"],
  paths(files: string[]) {
    return files.map((file) => ({ params: { page: basename(file, ".md") }, content: readFileSync(file, "utf8") }));
  },
};
