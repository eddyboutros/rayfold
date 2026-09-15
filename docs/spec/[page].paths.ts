// The specification lives in spec/ at the root of the repository; each file there is a page here.
import { readFileSync } from "node:fs";
import { basename } from "node:path";

export default {
  watch: ["../../spec/*.md"],
  paths(files: string[]) {
    return files.map((file) => ({ params: { page: basename(file, ".md") }, content: readFileSync(file, "utf8") }));
  },
};
