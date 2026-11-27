import path from 'node:path';
import type { NextConfig } from 'next';

// One .env at the repository root serves every app; only NEXT_PUBLIC_* values reach the browser.
try {
  process.loadEnvFile(path.resolve(process.cwd(), '../../.env'));
} catch {
  // Variables are provided by the environment.
}

// Names this build. The service worker is registered under the name, so each new build replaces the copy of the app
// that devices keep for opening without the internet.
const buildId = process.env.POS_BUILD_ID ?? Date.now().toString(36);

const nextConfig: NextConfig = {
  transpilePackages: ['@pos/ui'],
  devIndicators: false,
  generateBuildId: async () => buildId,
  env: { POS_BUILD_ID: buildId },
  // The service worker must always be fetched fresh, or devices would keep an old one.
  async headers() {
    return [{
      source: '/sw.js',
      headers: [
        { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
        { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
      ],
    }];
  },
  // The end-to-end tests run their own copy of this app next to the dev server, in a separate build folder.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  turbopack: {
    rules: {
      '*.css': { loaders: ['@tailwindcss/turbopack'], as: '*.css' },
    },
  },
};

export default nextConfig;
