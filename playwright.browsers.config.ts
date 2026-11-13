import { defineConfig, devices } from '@playwright/test';

// Cross-engine run of the same multi-visitor tests: npx playwright test -c playwright.browsers.config.ts
export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results/pw-browsers',
  timeout: 180_000,
  expect: { timeout: 45_000 },
  workers: 1,
  reporter: [['list']],
  use: { baseURL: process.env.ONE_SKY_URL ?? 'http://localhost:5173/', viewport: { width: 1280, height: 800 } },
  projects: [
    { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1280, height: 800 } } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 800 } } },
  ],
});
