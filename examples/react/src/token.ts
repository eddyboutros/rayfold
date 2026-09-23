// Prints a token signed with the development key, as an identity provider would issue one at sign-in:
//   npm run token -- staff
import { devToken } from "./auth.ts";

const role = process.argv[2] === "staff" ? "staff" : "customer";
console.log(await devToken(role === "staff" ? "s1" : "u1", role));
