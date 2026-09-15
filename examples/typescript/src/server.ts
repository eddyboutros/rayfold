import { bookshopHttp, createBookshop } from "./bookshop.ts";

const { server } = createBookshop();

bookshopHttp(server).listen(4000, () => {
  console.log("Rayfold on http://localhost:4000/rayfold");
  console.log("Explorer on http://localhost:4000/rayfold/explorer");
});
