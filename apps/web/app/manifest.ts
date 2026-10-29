import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Sleep Lab',
    short_name: 'Sleep Lab',
    description: 'Bedroom air, aircon curve and sleep reports for two.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#0e0e0f',
    theme_color: '#0e0e0f',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
