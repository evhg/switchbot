import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@sleep-lab/core'],
  reactStrictMode: true,
  // Lets a second build or dev server run beside a production one without sharing .next.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  poweredByHeader: false,
  // Invalidates the browser's cached simulated dataset whenever a new build ships (lib/data/engine-cache.ts).
  env: { NEXT_PUBLIC_BUILD_ID: String(Date.now()) },
  async headers() {
    return [
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ];
  },
};

export default nextConfig;
