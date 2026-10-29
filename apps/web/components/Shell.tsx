'use client';
import { usePathname } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { DataProvider, useData } from '@/lib/data/context.tsx';
import { dayLabel } from '@/lib/format.ts';
import { ThemeProvider } from '@/lib/theme.tsx';
import { subscribeScroll, useNavTransitionDone } from './motion.tsx';
import { TabBar } from './TabBar.tsx';

function useServiceWorker() {
  useEffect(() => {
    // Hydrated: the reveal system (IntersectionObserver + motion JS) is live, so hidden initial states may stay armed.
    document.documentElement.setAttribute('data-hydrated', '');
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }, []);
}

/** Toggles <html data-scrolled> once the page is scrolled past 56 px (drives the compact top bar). No React state. */
function useScrolledFlag() {
  useEffect(() => {
    let on = false;
    return subscribeScroll((y) => {
      const next = y > 56;
      if (next === on) return;
      on = next;
      if (on) document.documentElement.setAttribute('data-scrolled', '');
      else document.documentElement.removeAttribute('data-scrolled');
    });
  }, []);
}

/**
 * Story pages (Today) hide the generic compact top bar and draw their own StoryHeader.
 * Call from the page: useStoryChrome().
 */
export function useStoryChrome() {
  useEffect(() => {
    document.documentElement.setAttribute('data-story', '');
    return () => document.documentElement.removeAttribute('data-story');
  }, []);
}

const TITLES: Record<string, string> = { '/': 'Last night', '/room': 'Room', '/body': 'Body', '/lab': 'Lab', '/settings': 'System' };

function TopBar() {
  const path = usePathname();
  const { date, sourceKind } = useData();
  const title = TITLES[path] ?? 'Sleep Lab';
  return (
    <div className="topbar" aria-hidden>
      <div className="topbar-in">
        <span className="topbar-title">{title}</span>
        <span className="topbar-meta t-label">
          {date ? dayLabel(date) : ''}
          {sourceKind === 'sim' ? ' · SIM' : ''}
        </span>
      </div>
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  useServiceWorker();
  useScrolledFlag();
  useNavTransitionDone();
  const path = usePathname();
  return (
    <ThemeProvider>
      <DataProvider>
        <TopBar />
        <main className="shell">
          <div className="page" key={path}>
            {children}
          </div>
        </main>
        <TabBar />
      </DataProvider>
    </ThemeProvider>
  );
}
