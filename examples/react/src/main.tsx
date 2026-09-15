import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RayfoldClient, createFetchTransport } from "@rayfold/client";
import { RayfoldProvider } from "@rayfold/react";
import { App } from "./App.tsx";

// #region provider
const client = new RayfoldClient({
  transport: createFetchTransport({
    url: "/rayfold",
    headers: () => ({ authorization: "Bearer customer" }),
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
