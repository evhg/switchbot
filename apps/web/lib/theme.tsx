'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ictHour } from './format.ts';
import { usePref } from './prefs.ts';

export type ThemeMode = 'auto' | 'light' | 'dark' | 'night';
export type ResolvedTheme = 'light' | 'dark' | 'night';

/** Night mode window in ICT (21:00–07:00). */
export const isNightHour = (ts: number) => {
  const h = ictHour(ts);
  return h >= 21 || h < 7;
};

/** Browser chrome / status bar colour per theme (matches --bg). */
export const THEME_COLOR: Record<ResolvedTheme, string> = { light: '#f4f3ef', dark: '#0e0e0f', night: '#000000' };

/** `?theme=light|dark|night` forces a theme for this page view (screenshots); never persisted. */
function queryTheme(): ResolvedTheme | null {
  if (typeof window === 'undefined') return null;
  const q = new URLSearchParams(window.location.search).get('theme');
  return q === 'light' || q === 'dark' || q === 'night' ? q : null;
}

function resolve(mode: ThemeMode, now: number, systemDark: boolean): ResolvedTheme {
  if (mode !== 'auto') return mode;
  if (isNightHour(now)) return 'night';
  return systemDark ? 'dark' : 'light';
}

interface ThemeCtx {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (m: ThemeMode) => void;
}
const Ctx = createContext<ThemeCtx>({ mode: 'auto', resolved: 'light', setMode: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = usePref<ThemeMode>('themeMode', 'auto');
  const [now, setNow] = useState(() => Date.now());
  const [systemDark, setSystemDark] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [forced, setForced] = useState<ResolvedTheme | null>(queryTheme);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    setSystemDark(mq.matches);
    setForced(queryTheme());
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', on);
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      mq.removeEventListener('change', on);
      window.clearInterval(id);
    };
  }, []);

  const resolved = forced ?? resolve(mode, now, systemDark);
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolved);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[resolved]);
  }, [resolved]);

  // Choosing a theme in the app ends a ?theme= override.
  const choose = useCallback(
    (m: ThemeMode) => {
      setForced(null);
      setMode(m);
    },
    [setMode],
  );
  const value = useMemo(() => ({ mode, resolved, setMode: choose }), [mode, resolved, choose]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);
