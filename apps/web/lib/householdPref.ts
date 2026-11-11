'use client';
/**
 * A setting shared by the household (public.household_prefs, migration 0037), e.g. the aircon filter's last clean and
 * the CO₂ meter's outdoor checks. It behaves like usePref (lib/prefs.ts, this device) and also, when signed in on real
 * data, reads the household's value once and writes every change back, so both phones show the same thing.
 */
import { useCallback, useEffect } from 'react';
import { useAuth } from './auth.tsx';
import { supabaseClient } from './data/supabase.ts';
import { usePref } from './prefs.ts';

export function useHouseholdPref<T>(key: string, fallback: T): [T, (v: T | ((prev: T) => T)) => void, boolean] {
  const [value, setLocal, loaded] = usePref<T>(key, fallback);
  const auth = useAuth();
  const live = auth.status === 'signed-in' && auth.probe?.member === true;

  useEffect(() => {
    if (!live) return;
    let alive = true;
    void supabaseClient()
      .from('household_prefs')
      .select('value')
      .eq('key', key)
      .maybeSingle()
      .then(({ data }) => {
        if (alive && data && data.value !== undefined) setLocal(data.value as T);
      });
    return () => {
      alive = false;
    };
  }, [live, key, setLocal]);

  const set = useCallback(
    (v: T | ((prev: T) => T)) => {
      setLocal((prev) => {
        const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
        if (live) void supabaseClient().from('household_prefs').upsert({ key, value: next as unknown, updated_at: new Date().toISOString() }).then(() => undefined);
        return next;
      });
    },
    [live, key, setLocal],
  );
  return [value, set, loaded];
}
