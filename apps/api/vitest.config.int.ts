import { defineConfig } from 'vitest/config';
import { testEnv } from './test/support/test-env.js';

// Integration tests: real PostgreSQL, Redis and Mailpit from `pnpm infra:up`, on a separate test database.
export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.int-spec.ts'],
    globalSetup: './test/support/global-setup.ts',
    env: testEnv(),
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
