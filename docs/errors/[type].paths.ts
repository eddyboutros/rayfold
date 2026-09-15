import { ERROR_TYPES, errorPage } from "../.vitepress/errors.ts";

export default {
  paths() {
    return ERROR_TYPES.map((e) => ({ params: { type: e.type }, content: errorPage(e) }));
  },
};
