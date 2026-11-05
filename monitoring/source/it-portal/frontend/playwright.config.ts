import { defineConfig } from '@playwright/test';

const baseURL = process.env.PORTAL_E2E_URL || 'http://localhost:8099';
if (!['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname)) {
  throw new Error('E2E is restricted to the explicitly isolated local demo');
}
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45000,
  expect: { timeout: 10000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL, browserName: 'chromium', channel: 'chrome', viewport: { width: 1920, height: 1080 }, trace: 'off', screenshot: 'only-on-failure', timezoneId: 'Europe/Moscow' },
  webServer: process.env.PORTAL_E2E_EXTERNAL ? undefined : {
    command: `PORTAL_VITE_CACHE_DIR=node_modules/.vite-e2e PORTAL_API_URL=${process.env.PORTAL_E2E_API_URL || 'http://127.0.0.1:8082'} npm run dev -- --port ${new URL(baseURL).port || '8099'} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30000,
  },
});
