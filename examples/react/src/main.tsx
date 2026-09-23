// #region provider
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RayfoldClient, createFetchTransport } from "@rayfold/client";
import { RayfoldProvider } from "@rayfold/react";
import { App } from "./App.tsx";
import { accessToken } from "./session.ts";

const client = new RayfoldClient({
  transport: createFetchTransport({
    url: "/rayfold",
    // read on every request, so a token the sign-in refreshed is the one sent
    headers: async () => ({ authorization: `Bearer ${await accessToken()}` }),
  }),
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RayfoldProvider client={client}>
      <App />
    </RayfoldProvider>
  </StrictMode>,
);
// #endregion provider
