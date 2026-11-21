import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config.ts';

/**
 * Feature 03 browser/device matrix, on top of the daily Edge run (`bun run test:e2e`). One worker:
 * the live specs bind fixed helper ports, and each file runs once per project.
 *
 * Firefox and WebKit run on Linux in the official Playwright image, whatever the host
 * (`docker compose --profile e2e-browsers up -d playwright-browsers`), loopback reaching back to this
 * machine. That WebKit is the engine, not Safari, and phone projects are viewport, touch, and engine
 * emulation, not real devices.
 */
const remote = {
  connectOptions: {
    wsEndpoint: process.env.PLAYWRIGHT_BROWSERS_ENDPOINT ?? 'ws://127.0.0.1:3000/',
    exposeNetwork: '<loopback>',
  },
};
// Sync reaches WebKit late under Playwright (about 25 s for a first checkpoint); not seen elsewhere.
const WEBKIT_TIMEOUT = 180_000;
process.env.E2E_SYNC_TIMEOUT_MS ??= '90000';

export default defineConfig({
  ...base,
  workers: 1,
  // Remote engines and emulation run the same specs slower than the daily 30 s budget assumes.
  timeout: 60_000,
  // Not `...base.use`: its `msedge` channel is invalid for these engines.
  use: { baseURL: base.use?.baseURL ?? '', headless: true },
  projects: [
    { name: 'mobile-chromium', use: devices['Pixel 7'] },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], ...remote } },
    { name: 'webkit', timeout: WEBKIT_TIMEOUT, use: { ...devices['Desktop Safari'], ...remote } },
    {
      name: 'mobile-webkit',
      timeout: WEBKIT_TIMEOUT,
      use: { ...devices['iPhone 15'], ...remote },
    },
  ],
});
