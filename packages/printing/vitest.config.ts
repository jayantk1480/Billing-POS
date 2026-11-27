import { defineConfig } from 'vitest/config';

// The layout tests use Vitest's globals (describe, it, expect), as they did in the API.
export default defineConfig({
  test: { globals: true, root: './', include: ['src/**/*.spec.ts'] },
});
