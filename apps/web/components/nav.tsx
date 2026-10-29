'use client';
/**
 * Navigation model shared by the desktop Sidebar, the phone TopBar / TabBar and the System screens
 * (docs/DESIGN.md §5.3, §9.5). One source for the destinations, System's second level and the night picker.
 *
 *   TABS                       the five destinations (href, label, icon)
 *   SYSTEM_PAGES               System's sub-pages in sidebar order, grouped (route = `/settings/${slug}`)
 *   systemHref(slug)           '/settings/plan' …
 *   activeTab(path)            index into TABS for a pathname
 *   useNightNav()              { date, title: 'Thu 29 Oct', sub: 'Night of Wed 28', prev, next, canPrev, canNext,
 *                                dates, setDate, ready }
 *   useChrome({ title, back }) a page sets the phone top bar's secondary text (e.g. the current chapter) or turns
 *                              it into a drill-in bar with a "‹ System" back link. Cleared on unmount.
 *   setTopbarProgress(p)       0..1, Today's 2 px progress line on the phone top bar (call from a scroll frame).
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useData } from '@/lib/data/context.tsx';
import { addDays, shortDay } from '@/lib/format.ts';
import type { IconName } from './icons.tsx';

export const TABS: readonly { href: string; label: string; icon: IconName }[] = [
  { href: '/', label: 'Today', icon: 'moon' },
  { href: '/room', label: 'Room', icon: 'house' },
  { href: '/body', label: 'Body', icon: 'pulse' },
  { href: '/lab', label: 'Lab', icon: 'flask' },
  { href: '/settings', label: 'System', icon: 'gear' },
];

export type SystemSlug = 'plan' | 'tags' | 'general' | 'morning' | 'data' | 'health' | 'co2' | 'setup' | 'diagnostics';
export const SYSTEM_GROUPS: readonly { label: string; pages: readonly { slug: SystemSlug; label: string }[] }[] = [
  {
    label: 'Tonight',
    pages: [
      { slug: 'plan', label: 'Tonight’s plan' },
      { slug: 'tags', label: 'Tonight’s tags' },
    ],
  },
  {
    label: 'Household',
    pages: [
      { slug: 'general', label: 'General' },
      { slug: 'morning', label: 'Morning report' },
    ],
  },
  {
    label: 'Data and devices',
    pages: [
      { slug: 'data', label: 'Data & devices' },
      { slug: 'health', label: 'Google Health' },
      { slug: 'co2', label: 'CO₂ calibration' },
    ],
  },
  {
    label: 'Help',
    pages: [
      { slug: 'setup', label: 'Setup guide' },
      { slug: 'diagnostics', label: 'Diagnostics' },
    ],
  },
];
export const SYSTEM_PAGES = SYSTEM_GROUPS.flatMap((g) => g.pages);
export const systemHref = (slug: SystemSlug) => `/settings/${slug}`;
/** Desktop opens System on this page (§9.5). */
export const SYSTEM_DEFAULT: SystemSlug = 'plan';

/** Index into TABS for a pathname, or -1 when the route is not under a tab. */
export const activeTab = (path: string) => TABS.findIndex((t) => (t.href === '/' ? path === '/' : path === t.href || path.startsWith(`${t.href}/`)));

const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayNum = (date: string) => Number(date.slice(8, 10));
/** "Thu 29 Oct" */
export const nightTitle = (date: string) => `${shortDay(date)} ${dayNum(date)} ${MO[Number(date.slice(5, 7)) - 1]}`;
/** "Night of Wed 28" (the evening before the wake date) */
export const nightSub = (date: string) => {
  const eve = addDays(date, -1);
  return `Night of ${shortDay(eve)} ${dayNum(eve)}`;
};

export function useNightNav() {
  const { dataset, latest, date, setDate } = useData();
  const ds = dataset ?? latest;
  const dates = ds?.nights.map((n) => n.date) ?? [];
  const i = date ? dates.indexOf(date) : -1;
  // The dates are known from the preview (latest) already; no need to wait for the full worker result.
  const ready = !!ds;
  const canPrev = i > 0;
  const canNext = i >= 0 && i < dates.length - 1;
  const prev = useCallback(() => {
    if (canPrev) setDate(dates[i - 1]!);
  }, [canPrev, dates, i, setDate]);
  const next = useCallback(() => {
    if (canNext) setDate(dates[i + 1]!);
  }, [canNext, dates, i, setDate]);
  return {
    date,
    dates,
    setDate,
    ready,
    title: date ? nightTitle(date) : '',
    sub: date ? nightSub(date) : '',
    canPrev,
    canNext,
    prev,
    next,
  };
}

// ───────────────────────── phone top bar context (tiny external store) ─────────────────────────

export interface ChromeState {
  /** Secondary text after the date (e.g. the current chapter). Defaults to the tab name. */
  title?: string;
  /** Drill-in: replaces the date with a back link. */
  back?: { href: string; label: string };
}
let chrome: ChromeState = {};
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};

export function useChromeState(): ChromeState {
  return useSyncExternalStore(subscribe, () => chrome, () => chrome);
}

export function useChrome(state: ChromeState) {
  const title = state.title;
  const href = state.back?.href;
  const label = state.back?.label;
  useEffect(() => {
    chrome = { title, back: href && label ? { href, label } : undefined };
    emit();
    return () => {
      chrome = {};
      emit();
    };
  }, [title, href, label]);
}

let progressEl: HTMLElement | null = null;
let lastP = -1;
export const registerProgressEl = (el: HTMLElement | null) => {
  progressEl = el;
  lastP = -1;
};
/** Today: 0..1 page progress for the phone top bar line. Writes a transform only. */
export function setTopbarProgress(p: number) {
  const q = Math.round(Math.max(0, Math.min(1, p)) * 1000) / 1000;
  if (q === lastP || !progressEl) return;
  lastP = q;
  progressEl.style.transform = `scaleX(${q})`;
}
