import type { Metadata, Viewport } from 'next';
import { Geist_Mono, Inter_Tight } from 'next/font/google';
import type { ReactNode } from 'react';
import { Shell } from '@/components/Shell.tsx';
import { THEME_BOOT } from '@/lib/theme-boot.ts';
import './globals.css';

// Display + UI face (variable 100–900; we use 300–800) and the mono label face (docs/DESIGN.md §2).
const display = Inter_Tight({ subsets: ['latin'], weight: 'variable', variable: '--font-display', display: 'swap' });
const mono = Geist_Mono({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-geist-mono', display: 'swap' });

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
  themeColor: '#000000',
  colorScheme: 'dark light',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
