import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import type { ReactNode } from 'react';
import { Shell } from '@/components/Shell.tsx';
import { THEME_BOOT } from '@/lib/theme-boot.ts';
import './globals.css';

// v2 "Instrument" (docs/DESIGN.md §4.1): Inter Tight only, variable 100–900 (we use 250–600), tabular numerals.
// Self-hosted latin subset (OFL) via next/font/local; next/font/google breaks the Vercel build.
const sans = localFont({
  src: './fonts/InterTight-latin-var.woff2',
  weight: '100 900',
  variable: '--font-display',
  display: 'swap',
  fallback: ['system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
});

export const metadata: Metadata = {
  title: 'Sleep Lab',
  description: 'Bedroom air, aircon curve and sleep reports for two.',
  applicationName: 'Sleep Lab',
  appleWebApp: { capable: true, title: 'Sleep Lab', statusBarStyle: 'black-translucent' },
  formatDetection: { telephone: false },
  icons: {
    icon: [{ url: '/icon.svg', type: 'image/svg+xml' }, { url: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
    apple: [{ url: '/apple-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  other: { 'apple-mobile-web-app-capable': 'yes' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  // Overwritten before first paint by THEME_BOOT and on theme change by ThemeProvider (THEME_COLOR).
  themeColor: '#0e0e0f',
  colorScheme: 'dark light',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={sans.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
