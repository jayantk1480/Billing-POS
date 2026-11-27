import { defineConfig } from 'vitest/config';

// Unit tests: no database or network.
export default defineConfig({
  test: { globals: true, root: './', include: ['src/**/*.spec.ts'], passWithNoTests: true },
});
