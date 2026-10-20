/**
 * Real browsers: Chromium, Firefox and WebKit (Safari's engine). `npm run test:browsers` runs two suites; run
 * `npx playwright install` once first.
 *
 * - The web demo (`demo.spec.ts`): starts the demo with a slice of the real catalogue and drives it.
 * - The documentation site (`site.spec.ts`): builds the site and serves the build as it is deployed, then opens every
 *   page and drives the home page and the playground.
 */
import { defineConfig, devices } from "@playwright/test";

const DEMO = "http://localhost:4610";
const SITE = "http://localhost:4173";
const browsers = [
  { name: "chromium", device: devices["Desktop Chrome"] },
  { name: "firefox", device: devices["Desktop Firefox"] },
  { name: "webkit", device: devices["Desktop Safari"] },
];

export default defineConfig({
  testDir: "e2e/browser",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  // one demo server whose stock and orders the tests change: one browser at a time, tests in order
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  outputDir: "test-results/browser",
  use: { trace: "retain-on-failure" },
  projects: [
    ...browsers.map((b) => ({ name: b.name, testMatch: "demo.spec.ts", use: { ...b.device, baseURL: DEMO } })),
    ...browsers.map((b) => ({ name: `site-${b.name}`, testMatch: "site.spec.ts", use: { ...b.device, baseURL: SITE } })),
  ],
  webServer: [
    {
      command: "npx tsx examples/bookstore-web/server.ts",
      url: `${DEMO}/`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { RAYFOLD_DEMO_LIMIT: "3000", RAYFOLD_ATTACK_REPORT: "test-results/browser/attacks.json" },
    },
    {
      command: "npm run docs:build && npx vitepress preview docs --port 4173 --strictPort",
      url: `${SITE}/`,
      reuseExistingServer: false,
      timeout: 300_000,
    },
  ],
});
