import { defineConfig } from 'vitest/config';

// Runs against a printer emulator and a stand-in API on this machine; no real printer or server is needed.
export default defineConfig({
  test: { globals: true, root: './', include: ['src/**/*.spec.ts'], testTimeout: 15_000 },
});
