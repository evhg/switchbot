'use client';
/**
 * Tonight's tags. Signed in as a household member: public.nights.tags for tonight's night, written with the existing
 * set_night RPC (migrations 0004/0025) passing only p_date and p_tags, so lights out, wake, curve and the aircon switch
 * stay as they are (a night without a row yet is created with the default 22:00 / 08:30, as the backend would).
 * Signed out or simulator: kept on this device, like before.
 */
import { useCallback, useEffect, useState } from 'react';
import type { TagKey } from '@sleep-lab/core';
import { useAuth } from './auth.tsx';
import { supabaseClient } from './data/supabase.ts';
import { usePref } from './prefs.ts';
import { DEFAULT_LIGHTS_OUT, DEFAULT_WAKE, nightTimes, tonightDate } from './tonight.ts';

export interface TonightTags {
  tags: TagKey[];
  toggle: (k: TagKey) => void;
  /** Wake date of tonight's night; null until mounted. */
  night: string | null;
  /** Stored in the household's nights row (vs. this device). */
  live: boolean;
  canWrite: boolean;
  loading: boolean;
  error: string | null;
}

export function useTonightTags(): TonightTags {
  const auth = useAuth();
  const live = auth.status === 'signed-in' && Boolean(auth.probe?.member);
  const canWrite = live && (auth.probe?.role === 'owner' || auth.probe?.role === 'member');
  const [store, setStore] = usePref<Record<string, TagKey[]>>('tags', {});
  const [night, setNight] = useState<string | null>(null);
  useEffect(() => setNight(tonightDate()), []);

  // undefined = not loaded; null = no nights row yet.
  const [remote, setRemote] = useState<TagKey[] | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!live || !night) return setRemote(undefined);
    let alive = true;
    supabaseClient()
      .from('nights')
      .select('tags')
      .eq('date', night)
      .maybeSingle()
      .then(({ data, error: e }) => {
        if (!alive) return;
        if (e) return setError(e.message), setRemote(null);
        const t = (data as { tags?: unknown } | null)?.tags;
        setRemote(data ? (Array.isArray(t) ? (t as TagKey[]) : []) : null);
      });
    return () => {
      alive = false;
    };
  }, [live, night]);

  const tags = !night ? [] : live ? remote ?? [] : store[night] ?? [];

  const toggle = useCallback(
    (k: TagKey) => {
      if (!night) return;
      if (!live) {
        setStore((st) => {
          const cur = st[night] ?? [];
          return { ...st, [night]: cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k] };
        });
        return;
      }
      if (!canWrite) return setError('Your household role is read-only.');
      if (remote === undefined) return;
      const before = remote;
      const cur = before ?? [];
      const next = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k];
      setRemote(next);
      setError(null);
      const args: Record<string, unknown> = { p_date: night, p_tags: next };
      if (before === null) {
        // No row yet: set_night needs lights out and wake to create it (the backend's defaults).
        const t = nightTimes(night, DEFAULT_LIGHTS_OUT, DEFAULT_WAKE);
        args.p_lights_out = new Date(t.lightsOut).toISOString();
        args.p_wake = new Date(t.wake).toISOString();
      }
      void supabaseClient()
        .rpc('set_night', args)
        .then(({ error: e }) => {
          if (e) {
            setRemote(before);
            setError(e.message);
          }
        });
    },
    [night, live, canWrite, remote, setStore],
  );

  return { tags, toggle, night, live, canWrite, loading: live && remote === undefined, error };
}
