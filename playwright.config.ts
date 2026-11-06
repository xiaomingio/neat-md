/*
Purpose: Run webview regressions in genuinely headless Chromium without desktop windows.
*/
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  use: { headless: true, viewport: { width: 1000, height: 650 } },
});
