'use client';
// Per-device preferences in localStorage. Every access is guarded: storage can be missing or throw
// (private mode, blocked site data), and the app must work without it.
import { useCallback, useEffect, useState } from 'react';

const EVT = 'sleeplab:pref';

export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(`sleeplab.${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writePref<T>(key: string, value: T): void {
  try {
    window.localStorage.setItem(`sleeplab.${key}`, JSON.stringify(value));
  } catch {
    /* storage unavailable: keep in memory only */
  }
  try {
    window.dispatchEvent(new CustomEvent(EVT, { detail: { key, value } }));
  } catch {
    /* ignore */
  }
}

/** useState backed by localStorage, synced across components. Starts at `fallback` until mounted. */
export function usePref<T>(key: string, fallback: T): [T, (v: T | ((prev: T) => T)) => void, boolean] {
  const [value, setValue] = useState<T>(fallback);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setValue(readPref(key, fallback));
    setLoaded(true);
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ key: string; value: T }>).detail;
      if (d?.key === key) setValue(d.value);
    };
    window.addEventListener(EVT, on);
    return () => window.removeEventListener(EVT, on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const set = useCallback(
    (v: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
        queueMicrotask(() => writePref(key, next));
        return next;
      });
    },
    [key],
  );
  return [value, set, loaded];
}
