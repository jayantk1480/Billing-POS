import path from 'node:path';
import type { NextConfig } from 'next';

// One .env at the repository root serves every app; only NEXT_PUBLIC_* values reach the browser.
try {
  process.loadEnvFile(path.resolve(process.cwd(), '../../.env'));
} catch {
  // Variables are provided by the environment.
}

const nextConfig: NextConfig = {
  // The end-to-end tests run their own copy of this app next to the dev server, in a separate build folder.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  transpilePackages: ['@pos/ui'],
  // The floating dev badge sits on top of the sidebar's Sign out button.
  devIndicators: false,
  turbopack: {
    rules: {
      '*.css': { loaders: ['@tailwindcss/turbopack'], as: '*.css' },
    },
  },
};

export default nextConfig;
