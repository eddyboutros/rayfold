/**
 * The web demo in real browsers: Chromium, Firefox and WebKit (Safari's engine). `npm run test:browsers` starts the
 * demo with a slice of the real catalogue and drives it; run `npx playwright install` once first.
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e/browser",
  testMatch: "*.spec.ts",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  // one demo server whose stock and orders the tests change: one browser at a time, tests in order
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  outputDir: "test-results/browser",
  use: { baseURL: "http://localhost:4610", trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: "npx tsx examples/bookstore-web/server.ts",
    url: "http://localhost:4610/",
    reuseExistingServer: false,
    timeout: 120_000,
    env: { RAYFOLD_DEMO_LIMIT: "3000", RAYFOLD_ATTACK_REPORT: "test-results/browser/attacks.json" },
  },
});
