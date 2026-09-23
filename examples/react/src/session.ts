/// <reference types="vite/client" />
/**
 * The signed-in user's access token. In an application this is the identity provider's SDK: Auth0's
 * `getAccessTokenSilently()`, MSAL's `acquireTokenSilent()`, Keycloak's `updateToken()`, each of which hands back a
 * current token and refreshes it before it expires.
 *
 * Until one is wired in, the bookshop's development token stands in for it: `npm run token` prints one, which goes in
 * `.env.local` as `VITE_DEV_TOKEN`. Every example server accepts it, since they share one development key.
 */
export async function accessToken(): Promise<string> {
  const token = import.meta.env["VITE_DEV_TOKEN"] as string | undefined;
  if (!token) throw new Error("No access token: sign-in is not wired in, and VITE_DEV_TOKEN is not set in .env.local");
  return token;
}
