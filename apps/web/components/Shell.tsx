'use client';
/**
 * App shell (docs/DESIGN.md §5): desktop (≥1024) = Sidebar + content column; phone = sticky TopBar + bottom TabBar.
 *
 *   <div.app>
 *     <aside.sidebar/>                         ≥1024 only
 *     <div.app-main>
 *       <header.topbar/>                       <1024 only: date · page, ‹ › nights (or a "‹ System" back link)
 *       <main.shell><div.page>{children}</div><footer.site-foot/></main>   footer: Privacy link, every page
 *     </div>
 *     <nav.tabbar/>                            <1024 only
 *   </div>
 *
 * Pages lay themselves out inside .shell with the layout classes in styles/components.css (.content, .grid12,
 * .measure, .measure-plan, .section …). Keyboard: [ and ] move between nights.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { AuthProvider } from '@/lib/auth.tsx';
import { DataProvider, useData } from '@/lib/data/context.tsx';
import { ThemeProvider } from '@/lib/theme.tsx';
import { NotMember, Onboarding } from './account/Onboarding.tsx';
import { Icon } from './icons.tsx';
import { subscribeScroll, useNavTransitionDone } from './motion.tsx';
import { SYSTEM_PAGES, TABS, activeTab, registerProgressEl, systemHref, useChromeState, useNightNav } from './nav.tsx';
import { NightDateInput, Sidebar } from './Sidebar.tsx';
import { TabBar } from './TabBar.tsx';

function useServiceWorker() {
  useEffect(() => {
    // Hydrated: the reveal system (IntersectionObserver + motion JS) is live, so hidden initial states may stay armed.
    document.documentElement.setAttribute('data-hydrated', '');
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }, []);
}

/** Toggles <html data-scrolled> once the page has scrolled (drives the top bar hairline). No React state. */
function useScrolledFlag() {
  useEffect(() => {
    let on = false;
    return subscribeScroll((y) => {
      const next = y > 4;
      if (next === on) return;
      on = next;
      if (on) document.documentElement.setAttribute('data-scrolled', '');
      else document.documentElement.removeAttribute('data-scrolled');
    });
  }, []);
}

/**
 * Story pages (Today): the page goes edge to edge (no 12-col max width, no top padding) so scenes can bleed.
 *   useStoryChrome()                 v1 behaviour: also hides the phone top bar (for the old StoryHeader).
 *   useStoryChrome({ topbar: true }) v2: keep the shell top bar; set the chapter with useChrome({ title }) and
 *                                    the progress line with setTopbarProgress(p) (components/nav.tsx).
 */
export function useStoryChrome({ topbar = false }: { topbar?: boolean } = {}) {
  useEffect(() => {
    document.documentElement.setAttribute('data-story', topbar ? 'topbar' : '');
    return () => document.documentElement.removeAttribute('data-story');
  }, [topbar]);
}

function pageName(path: string): string {
  const sub = SYSTEM_PAGES.find((p) => path === `/settings/${p.slug}`);
  if (sub) return sub.label;
  if (path === '/signin') return 'Sign in';
  if (path === '/privacy') return 'Privacy';
  return TABS[activeTab(path)]?.label ?? 'Sleep Lab';
}

function TopBar() {
  const path = usePathname();
  const { title, back } = useChromeState();
  const n = useNightNav();
  const isToday = path === '/';
  return (
    <header className="topbar">
      {back ? (
        <Link href={back.href} className="topbar-back">
          <Icon name="chevron-left" size={20} />
          {back.label}
        </Link>
      ) : (
        <>
          <div className="topbar-t">
            <b className="topbar-date">
              {n.title || 'Sleep Lab'}
              <NightDateInput />
            </b>
            <span>{title ?? pageName(path)}</span>
          </div>
          <SourceTag />
          <button type="button" className="icon-btn" aria-label="Previous night" disabled={!n.canPrev} onClick={n.prev}>
            <Icon name="chevron-left" size={20} />
          </button>
          <button type="button" className="icon-btn" aria-label="Next night" disabled={!n.canNext} onClick={n.next}>
            <Icon name="chevron-right" size={20} />
          </button>
        </>
      )}
      {isToday && (
        <span className="topbar-progress" aria-hidden>
          <i ref={registerProgressEl} />
        </span>
      )}
    </header>
  );
}

/** Phone top bar: a small, honest "Simulated" label whenever the nights are generated (desktop: the sidebar footer). */
function SourceTag() {
  const { sourceKind } = useData();
  if (sourceKind !== 'sim') return null;
  return (
    <Link href={systemHref('data')} prefetch={false} className="topbar-src" title="Data & devices">
      Simulated
    </Link>
  );
}

/**
 * Real data chosen but nothing to chart: the tabs show the onboarding state (no nights yet) or the "not in the
 * household yet" state instead of empty charts. System and sign-in pages always render.
 */
function TabGate({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { empty, mode, realGate } = useData();
  if (activeTab(path) < 0 || path.startsWith('/settings')) return <>{children}</>;
  if (empty) return <Onboarding />;
  if (mode === 'supabase' && realGate === 'not-member') return <NotMember />;
  return <>{children}</>;
}

/** [ and ] move between nights (§10), unless typing. */
function useNightKeys() {
  const n = useNightNav();
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === '[') n.prev();
      else if (e.key === ']') n.next();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [n]);
}

function Frame({ children }: { children: ReactNode }) {
  useNightKeys();
  const path = usePathname();
  return (
    <div className="app">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <Sidebar />
      <div className="app-main">
        <TopBar />
        <main className="shell" id="main" tabIndex={-1}>
          <div className="page" key={path}>
            <TabGate>{children}</TabGate>
          </div>
          <footer className="site-foot">
            <Link href="/privacy">Privacy</Link>
          </footer>
        </main>
      </div>
      <TabBar />
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  useServiceWorker();
  useScrolledFlag();
  useNavTransitionDone();
  return (
    <ThemeProvider>
      <AuthProvider>
        <DataProvider>
          <Frame>{children}</Frame>
        </DataProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
