'use client';
import { useEffect, type ReactNode } from 'react';
import { DataProvider } from '@/lib/data/context.tsx';
import { ThemeProvider } from '@/lib/theme.tsx';
import { TabBar } from './TabBar.tsx';

function useServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }, []);
}

export function Shell({ children }: { children: ReactNode }) {
  useServiceWorker();
  return (
    <ThemeProvider>
      <DataProvider>
        <main className="shell">{children}</main>
        <TabBar />
      </DataProvider>
    </ThemeProvider>
  );
}
