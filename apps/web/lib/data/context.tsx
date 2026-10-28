'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Night, PersonNightMetrics, RoomNightMetrics, RoomReading } from '@sleep-lab/core';
import { HOUR } from '../format.ts';
import { usePref } from '../prefs.ts';
import { createSimSource } from './sim.ts';
import { createSupabaseSource, supabaseConfigured } from './supabase.ts';
import type { Dataset, DataSource, NightDetail, SourceKind } from './types.ts';

interface DataCtx {
  sourceKind: SourceKind;
  setSourceKind: (k: SourceKind) => void;
  source: DataSource;
  status: 'loading' | 'ready' | 'error';
  progress: string;
  error: string | null;
  dataset: Dataset | null;
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
  const [storedKind, setSourceKind] = usePref<SourceKind>('source', 'sim');
  const sourceKind: SourceKind = storedKind === 'supabase' && supabaseConfigured() ? 'supabase' : 'sim';
  const source = useMemo(() => (sourceKind === 'supabase' ? createSupabaseSource() : createSimSource()), [sourceKind]);
  const [state, setState] = useState<{ status: DataCtx['status']; dataset: Dataset | null; error: string | null; progress: string }>({
    status: 'loading',
    dataset: null,
    error: null,
    progress: 'Simulating 90 nights…',
  });
  const [date, setDate] = useState<string | null>(null);
  const [names, setNames] = usePref<Record<string, string>>('names', {});
  const setPersonName = useCallback(
    (id: string, name: string) => setNames((prev) => ({ ...prev, [id]: name.slice(0, MAX_NAME_LENGTH) })),
    [setNames],
  );

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, status: 'loading', error: null, progress: sourceKind === 'sim' ? 'Simulating 90 nights…' : 'Connecting…' }));
    source
      .loadDataset((progress) => alive && setState((s) => ({ ...s, progress })))
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
  }, [source, sourceKind]);

  // Names flow everywhere through dataset.people; an empty override falls back to the source's name.
  const dataset = useMemo<Dataset | null>(() => {
    const ds = state.dataset;
    if (!ds) return null;
    if (!ds.people.some((p) => names[p.id]?.trim())) return ds;
    return { ...ds, people: ds.people.map((p) => ({ ...p, name: names[p.id]?.trim() || p.name })) };
  }, [state.dataset, names]);

  const value = useMemo<DataCtx>(
    () => ({ sourceKind, setSourceKind, source, ...state, dataset, date, setDate, names, sourcePeople: state.dataset?.people ?? null, setPersonName }),
    [sourceKind, setSourceKind, source, state, dataset, date, names, setPersonName],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useData(): DataCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useData outside DataProvider');
  return c;
}

export interface SelectedNight {
  index: number;
  night: Night;
  room: RoomNightMetrics;
  person: Record<string, PersonNightMetrics | null>;
}

/** The night currently being viewed, plus its precomputed metrics. */
export function useSelectedNight(): SelectedNight | null {
  const { dataset, date } = useData();
  return useMemo(() => {
    if (!dataset || !date) return null;
    const index = dataset.nights.findIndex((n) => n.date === date);
    if (index < 0) return null;
    const person: Record<string, PersonNightMetrics | null> = {};
    for (const p of dataset.people) person[p.id] = dataset.person[p.id]?.[index] ?? null;
    return { index, night: dataset.nights[index]!, room: dataset.room[index]!, person };
  }, [dataset, date]);
}

export function useNightDetail(date: string | null | undefined): { detail: NightDetail | null; error: string | null } {
  const { source, status } = useData();
  const [res, setRes] = useState<{ key: string; detail: NightDetail | null; error: string | null }>({ key: '', detail: null, error: null });
  useEffect(() => {
    if (!date || status !== 'ready') return;
    let alive = true;
    source
      .loadNightDetail(date)
      .then((detail) => alive && setRes({ key: date, detail, error: null }))
      .catch((e: unknown) => alive && setRes({ key: date, detail: null, error: e instanceof Error ? e.message : String(e) }));
    return () => {
      alive = false;
    };
  }, [date, source, status]);
  // Keep the previous detail while the next loads (no layout jump), but flag it.
  return res.key === date ? res : { detail: res.detail, error: null };
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
export function withNames(text: string, dataset: Dataset | null): string {
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
