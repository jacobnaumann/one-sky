import { defineConfig } from '@playwright/test';

// E2E runs against a running site: the dev server by default, or production with
// ONE_SKY_URL=https://… npm run e2e
export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results/pw',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.ONE_SKY_URL ?? 'http://localhost:5173/',
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] },
    viewport: { width: 1280, height: 800 },
  },
});
