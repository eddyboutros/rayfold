import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "examples/*/src/**/*.test.ts", "conformance/src/**/*.test.ts", "e2e/**/*.test.ts", "docs/.vitepress/**/*.test.ts"],
    testTimeout: 5000,
  },
});
