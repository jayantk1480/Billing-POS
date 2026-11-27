import { defineConfig } from '@playwright/test';
import { ADMIN_PORT, ADMIN_URL, API_URL, KDS_PORT, KDS_URL, POS_PORT, POS_PROD_PORT, POS_PROD_URL, POS_URL, serverEnv, WEB_PORT, WEB_URL } from './support/env.js';

/**
 * End-to-end tests drive the real back office and POS in Chrome against a real API, on their own database
 * and ports, so they can run while the development stack is up. Needs `pnpm infra:up` and built shared packages (`pnpm build` once, or a running `pnpm dev`).
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './support/global-setup.ts',
  globalTeardown: './support/global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: WEB_URL,
    // Locally the installed Chrome is used; CI installs Playwright's own Chromium.
    channel: process.env.CI ? undefined : 'chrome',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      // Compiled into its own folder, so the tests always run current code and never disturb `pnpm dev`.
      command: 'pnpm exec tsc -p tsconfig.build.json --outDir dist-e2e --incremental false && node dist-e2e/main.js',
      cwd: '../apps/api',
      env: serverEnv,
      url: `${API_URL}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `pnpm exec next dev -p ${WEB_PORT}`,
      cwd: '../apps/web',
      env: { NEXT_PUBLIC_API_URL: API_URL, NEXT_PUBLIC_POS_URL: POS_URL, NEXT_DIST_DIR: '.next-e2e' },
      url: `${WEB_URL}/login`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `pnpm exec next dev -p ${POS_PORT}`,
      cwd: '../apps/pos',
      env: { NEXT_PUBLIC_API_URL: API_URL, NEXT_DIST_DIR: '.next-e2e' },
      url: POS_URL,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // Built and served as in production, for the tests of opening offline: the development server has no
      // service worker.
      command: `pnpm exec next build && pnpm exec next start -p ${POS_PROD_PORT}`,
      cwd: '../apps/pos',
      // The repository's .env says development, which a production build must not inherit.
      env: { NODE_ENV: 'production', NEXT_PUBLIC_API_URL: API_URL, NEXT_DIST_DIR: '.next-e2e-prod' },
      url: POS_PROD_URL,
      reuseExistingServer: false,
      timeout: 300_000,
    },
    {
      command: `pnpm exec next dev -p ${ADMIN_PORT}`,
      cwd: '../apps/admin',
      env: { NEXT_PUBLIC_API_URL: API_URL, NEXT_DIST_DIR: '.next-e2e' },
      url: `${ADMIN_URL}/login`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `pnpm exec next dev -p ${KDS_PORT}`,
      cwd: '../apps/kds',
      env: { NEXT_PUBLIC_API_URL: API_URL, NEXT_DIST_DIR: '.next-e2e' },
      url: KDS_URL,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
