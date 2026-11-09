import type { NextConfig } from 'next';

const OLD_HOSTS = ['sleep.cathnivore.com', 'sleep-lab-lac.vercel.app', 'sleep-lab-evhg.vercel.app'];

const nextConfig: NextConfig = {
  transpilePackages: ['@sleep-lab/core'],
  reactStrictMode: true,
  // Lets a second build or dev server run beside a production one without sharing .next.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  poweredByHeader: false,
  // Invalidates the browser's cached simulated dataset whenever a new build ships (lib/data/engine-cache.ts).
  env: { NEXT_PUBLIC_BUILD_ID: String(Date.now()) },
  // The app lives at jarvis.cathnivore.com (Sleep Lab until 2026-11-09). The old sleep.cathnivore.com and the
  // project's old *.vercel.app production addresses send every path there, so no one lands on a second copy.
  async redirects() {
    return OLD_HOSTS.map((host) => ({
      source: '/:path*',
      has: [{ type: 'host' as const, value: host }],
      destination: 'https://jarvis.cathnivore.com/:path*',
      permanent: true,
    }));
  },
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
