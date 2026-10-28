'use client';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ictHour } from './format.ts';
import { usePref } from './prefs.ts';

export type ThemeMode = 'auto' | 'light' | 'dark' | 'night';
export type ResolvedTheme = 'light' | 'dark' | 'night';

/** Night mode window in ICT (21:00–07:00). */
export const isNightHour = (ts: number) => {
  const h = ictHour(ts);
  return h >= 21 || h < 7;
};

const META: Record<ResolvedTheme, string> = { light: '#f3f2ef', dark: '#0d0d0d', night: '#000000' };



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
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    setSystemDark(mq.matches);
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', on);
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      mq.removeEventListener('change', on);
      window.clearInterval(id);
    };
  }, []);

  const resolved = resolve(mode, now, systemDark);
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolved);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', META[resolved]);
  }, [resolved]);

  const value = useMemo(() => ({ mode, resolved, setMode }), [mode, resolved, setMode]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);
