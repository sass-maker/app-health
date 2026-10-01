import { defineConfig } from '@playwright/test';
import process from 'node:process';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  workers: 3,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5194',
    channel: process.env.CI ? undefined : 'chrome',
    // UI telemetry fixtures should represent a real browser, not HeadlessChrome.
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    reducedMotion: 'reduce',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm dev --host 127.0.0.1 --port 5194 --strictPort',
    url: 'http://127.0.0.1:5194',
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
  },
});
