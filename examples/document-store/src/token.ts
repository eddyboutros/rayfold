// Prints a token signed with the development key, as an identity provider would issue one at sign-in:
//   npm run token -w @rayfold/example-document-store -- grace
import { devToken } from "./auth.ts";

const grace = process.argv[2] === "grace";
console.log(await devToken(grace ? "u2" : "u1", grace ? "Grace" : "Ada"));
