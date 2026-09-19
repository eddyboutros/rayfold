import { createDocumentStore, documentStoreHttp, scratchDirs } from "./documents.ts";

const dirs = await scratchDirs();
const shop = createDocumentStore(dirs);
documentStoreHttp(shop).listen(4000, () => {
  console.log("Rayfold on http://localhost:4000/rayfold");
  console.log(`uploads: ${dirs.uploads}`);
  console.log(`files:   ${dirs.files}`);
});
