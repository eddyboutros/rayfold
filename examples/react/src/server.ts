import { bookshopHttp, createBookshop } from "./bookshop.ts";

bookshopHttp(createBookshop().server).listen(4000, () => console.log("Rayfold on http://localhost:4000/rayfold"));
