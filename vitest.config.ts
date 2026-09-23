import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  test: {
    include: ["packages/*/src/**/*.test.ts", "examples/*/src/**/*.test.ts", "conformance/src/**/*.test.ts", "e2e/**/*.test.ts", "docs/.vitepress/**/*.test.ts"],
    testTimeout: 5000,
    // `npm run e2e` regenerates the committed e2e reports; a plain `npm test` runs the same assertions and writes nothing
    env: mode === "e2e" ? { E2E_WRITE: "1" } : {},
  },
}));
