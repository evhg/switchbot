'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Night, PersonNightMetrics, RoomNightMetrics, RoomReading } from '@sleep-lab/core';
import { hasRealData, useAuth } from '../auth.tsx';
import { HOUR, tidyReport } from '../format.ts';
import { usePref } from '../prefs.ts';
import { createSimSource } from './sim.ts';
import { createSupabaseSource, supabaseConfigured } from './supabase.ts';
import type { Dataset, DataSource, NightDetail, RealNightInfo, SourceKind } from './types.ts';

/** What the viewer asked for under System › Data & devices. 'auto' picks real data once it exists. */
export type DataMode = 'auto' | 'supabase' | 'sim';

/**
 * Why real data isn't showing although it was asked for (or would be picked automatically):
 *   'checking'   session / membership still being checked
 *   'sign-in'    real data chosen, not signed in
 *   'not-member' signed in, but the account is not in household_members (RLS returns nothing)
 *   'no-data'    signed in, no real readings or Google Health data yet (auto keeps the simulator)
 *   'unavailable' the env isn't configured, so only the simulator exists
 */
export type RealGate = 'checking' | 'sign-in' | 'not-member' | 'no-data' | 'unavailable' | null;

interface DataCtx {
  /** The source actually showing. */
  sourceKind: SourceKind;
  mode: DataMode;
  setMode: (m: DataMode) => void;
  realGate: RealGate;
  /** Real data is showing but there are no nights yet: screens show the onboarding state instead of charts. */
  empty: boolean;
  source: DataSource;
  status: 'loading' | 'ready' | 'error';
  progress: string;
  error: string | null;
  /** The full dataset (all nights + metrics). Null until computed; history-dependent views wait for this. */
  dataset: Dataset | null;
  /**
   * Newest-night-first preview: a partial dataset (`partial: true`) that arrives well before `dataset` — first the
   * newest night only, then the newest 31 nights (enough for 30-night baselines of the newest night) — and the full
   * dataset once ready. Use for first paint of the latest night (Today).
   */
  latest: Dataset | null;
  /** Wake date of the night being viewed (shared across tabs). */
  date: string | null;
  setDate: (d: string) => void;
  /** Display-name overrides per person id (System → People), stored on this device. Already applied to dataset.people. */
  names: Record<string, string>;
  /** People as the source names them, before overrides (what an empty override falls back to). */
  sourcePeople: readonly { id: string; name: string }[] | null;
  setPersonName: (id: string, name: string) => void;
}

/** Longest display name accepted from the People editor. */
export const MAX_NAME_LENGTH = 24;

const Ctx = createContext<DataCtx | null>(null);

export function DataProvider({ children }: { children: ReactNode }) {
  const [mode, setMode, modeLoaded] = usePref<DataMode>('dataMode', 'auto');
  const auth = useAuth();
  const configured = supabaseConfigured();
  const member = Boolean(auth.status === 'signed-in' && auth.probe?.member);
  const realGate: RealGate = !configured
    ? 'unavailable'
    : !auth.settled || !modeLoaded
      ? 'checking'
      : auth.status !== 'signed-in'
        ? 'sign-in'
        : !auth.probe?.member
          ? 'not-member'
          : !hasRealData(auth.probe)
            ? 'no-data'
            : null;
  const sourceKind: SourceKind = member && (mode === 'supabase' || (mode === 'auto' && hasRealData(auth.probe))) ? 'supabase' : 'sim';
  // Hold the first load until the session is known, so a signed-in household doesn't flash the simulator first.
  const pending = configured && mode !== 'sim' && realGate === 'checking';
  const userId = auth.session?.user.id ?? null;
  const source = useMemo(
    () => (sourceKind === 'supabase' ? createSupabaseSource() : createSimSource()),
    // A new session (sign in as someone else) needs a fresh source; the sim ignores it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sourceKind, sourceKind === 'supabase' ? userId : null],
  );
  const [state, setState] = useState<{ status: DataCtx['status']; dataset: Dataset | null; error: string | null; progress: string }>({
    status: 'loading',
    dataset: null,
    error: null,
    progress: 'Simulating 90 nights…',
  });
  const [preview, setPreview] = useState<Dataset | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [names, setNames] = usePref<Record<string, string>>('names', {});
  const setPersonName = useCallback(
    (id: string, name: string) => setNames((prev) => ({ ...prev, [id]: name.slice(0, MAX_NAME_LENGTH) })),
    [setNames],
  );

  useEffect(() => {
    if (pending) return;
    let alive = true;
    setState((s) => ({ ...s, status: 'loading', error: null, progress: sourceKind === 'sim' ? 'Simulating 90 nights…' : 'Connecting…' }));
    setPreview(null);
    source
      .loadDataset(
        (progress) => alive && setState((s) => (s.status === 'loading' ? { ...s, progress } : s)),
        (partial) => {
          if (!alive) return;
          setPreview(partial);
          const last = partial.nights.at(-1)?.date ?? null;
          setDate((d) => d ?? last);
        },
      )
      .then((dataset) => {
        if (!alive) return;
        setState({ status: 'ready', dataset, error: null, progress: '' });
        // ?date=YYYY-MM-DD (the morning push opens /?date=…) wins on first load.
        const asked = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('date') : null;
        const has = (x: string | null) => x !== null && dataset.nights.some((n) => n.date === x);
        setDate((d) => (has(asked) ? asked : has(d) ? d : dataset.nights.at(-1)?.date ?? null));
      })
      .catch((e: unknown) => {
        if (!alive) return;
        const error = e instanceof Error ? e.message : String(e);
        setState({ status: 'error', dataset: null, error, progress: `Couldn't load data (${error}). Change the source under System.` });
      });
    return () => {
      alive = false;
    };
  }, [source, sourceKind, pending]);

  // Names flow everywhere through dataset.people; an empty override falls back to the source's name.
  const applyNames = useCallback(
    (ds: Dataset | null): Dataset | null => {
      if (!ds) return null;
      if (!ds.people.some((p) => names[p.id]?.trim())) return ds;
      return { ...ds, people: ds.people.map((p) => ({ ...p, name: names[p.id]?.trim() || p.name })) };
    },
    [names],
  );
  const dataset = useMemo(() => applyNames(state.dataset), [state.dataset, applyNames]);
  const latest = useMemo(() => dataset ?? applyNames(preview), [dataset, preview, applyNames]);

  const value = useMemo<DataCtx>(
    () => ({
      sourceKind,
      mode,
      setMode,
      realGate,
      empty: sourceKind === 'supabase' && state.status === 'ready' && !!state.dataset && state.dataset.nights.length === 0,
      source,
      ...state,
      dataset,
      latest,
      date,
      setDate,
      names,
      sourcePeople: state.dataset?.people ?? preview?.people ?? null,
      setPersonName,
    }),
    [sourceKind, mode, setMode, realGate, source, state, dataset, latest, preview, date, names, setPersonName],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useData(): DataCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useData outside DataProvider');
  return c;
}

export interface SelectedNight {
  /** Index into the dataset this came from (`dataset`, or the 1-night preview while `partial`). */
  index: number;
  /** True while only the newest night is available (history-dependent views should show skeletons). */
  partial: boolean;
  night: Night;
  room: RoomNightMetrics;
  person: Record<string, PersonNightMetrics | null>;
}

/**
 * The night currently being viewed, plus its precomputed metrics. Available from the newest-night preview
 * (partial: true) before the full dataset is ready.
 */
export function useSelectedNight(): SelectedNight | null {
  const { latest, date } = useData();
  return useMemo(() => {
    if (!latest || !date) return null;
    const index = latest.nights.findIndex((n) => n.date === date);
    if (index < 0) return null;
    const person: Record<string, PersonNightMetrics | null> = {};
    for (const p of latest.people) person[p.id] = latest.person[p.id]?.[index] ?? null;
    return { index, partial: !!latest.partial, night: latest.nights[index]!, room: latest.room[index]!, person };
  }, [latest, date]);
}

export function useNightDetail(date: string | null | undefined): { detail: NightDetail | null; error: string | null } {
  const { source, status, latest } = useData();
  const [res, setRes] = useState<{ key: string; detail: NightDetail | null; error: string | null }>({ key: '', detail: null, error: null });
  // The engine can answer detail for the newest night as soon as the preview exists (it interleaves with the
  // history computation), so don't wait for the full dataset.
  const canLoad = status === 'ready' || (status === 'loading' && !!latest && latest.nights.some((n) => n.date === date));
  useEffect(() => {
    if (!date || !canLoad) return;
    let alive = true;
    source
      .loadNightDetail(date)
      .then((detail) => alive && setRes({ key: date, detail, error: null }))
      .catch((e: unknown) => alive && setRes({ key: date, detail: null, error: e instanceof Error ? e.message : String(e) }));
    return () => {
      alive = false;
    };
  }, [date, source, canLoad]);
  // Keep the previous detail while the next loads (no layout jump), but flag it.
  return res.key === date ? res : { detail: res.detail, error: null };
}

/** Real-data facts for a night (gaps, who ran the aircon, the morning report); null for the simulator or until loaded. */
export function useNightInfo(date: string | null | undefined): RealNightInfo | null {
  const { source, status } = useData();
  const [res, setRes] = useState<{ key: string; info: RealNightInfo | null }>({ key: '', info: null });
  useEffect(() => {
    if (!date || !source.nightInfo || status !== 'ready') return;
    let alive = true;
    source
      .nightInfo(date)
      .then((info) => alive && setRes({ key: date, info }))
      .catch(() => alive && setRes({ key: date, info: null }));
    return () => {
      alive = false;
    };
  }, [date, source, status]);
  return res.key === date ? res.info : null;
}

/** Live room data: latest reading and the last `hours` hours, refreshed every 60 s. */
export function useLive(hours = 6): { now: number; reading: RoomReading | null; history: RoomReading[] } {
  const { source } = useData();
  const [now, setNow] = useState(() => Date.now());
  const [data, setData] = useState<{ reading: RoomReading | null; history: RoomReading[] }>({ reading: null, history: [] });
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    let alive = true;
    Promise.all([source.liveReading(now), source.liveWindow(now - hours * HOUR, now)])
      .then(([reading, history]) => alive && setData({ reading, history }))
      .catch(() => alive && setData({ reading: null, history: [] }));
    return () => {
      alive = false;
    };
  }, [source, now, hours]);
  return { now, ...data };
}

export const personName = (dataset: Dataset | null, id: string) => dataset?.people.find((p) => p.id === id)?.name ?? id;

/** Rule-report text uses person ids ("a: HRV …"); show names instead. */
export function withNames(raw: string, dataset: Dataset | null): string {
  const text = tidyReport(raw);
  if (!dataset) return text;
  let out = text;
  for (const p of dataset.people) out = out.replace(new RegExp(`(^|\\s)${p.id}:`, 'g'), `$1${p.name}:`);
  return out;
}

/** Identity colour of a person (categorical slot by position: first = slot 1, second = slot 2). */
export function personColor(people: readonly { id: string }[], id: string): string {
  const i = people.findIndex((p) => p.id === id);
  return i === 1 ? 'var(--person-b)' : 'var(--person-a)';
}
