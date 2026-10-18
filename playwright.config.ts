import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: "http://localhost:3200", trace: "retain-on-failure" },
  // Phone runs first: the desktop suite ends by quarantining the shared seeded batch.
  projects: [
    { name: "phone", use: { ...devices["Pixel 7"] }, grep: /@phone/ },
    // Opt-in Safari check of the phone specs: E2E_WEBKIT=1 without E2E_PROD, since WebKit drops the
    // production build's Secure session cookie on http://localhost.
    ...(process.env.E2E_WEBKIT ? [{ name: "webkit-phone", use: { ...devices["iPhone 14"] }, grep: /@phone/ }] : []),
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }, dependencies: ["phone"] },
  ],
  webServer: {
    command: "npx tsx scripts/e2e-server.mts",
    url: "http://localhost:3200/api/health",
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
  },
});
