import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // the app calls /rayfold on the dev server, which passes it on to src/server.ts
  server: { proxy: { "/rayfold": "http://localhost:4000" } },
});
