'use client';
/**
 * Sound labels (migration 0030): the household's "Snoring" / "Not snoring" verdict on a sound event, shown under each
 * clip (Today › Snoring & noise, Today › Sleep talk, Live › Latest moments). The night-sound Edge Function hands them
 * to the Mac every evening, which retunes its snore rule from them; the app counts a labelled minute as snoring (or
 * not) whatever the detector said (core nightSoundSummary / wakeTriggers read SoundEvent.humanLabel).
 *
 *   useSoundLabels(real, canWrite)   all labels (event id → { label, who }), the counts, and setLabel(); one shared
 *                                    store, so Today and Live stay in step. Real: public.sound_labels (household read)
 *                                    and the label_sound_event RPC (owner/member), optimistic. Simulator: kept in
 *                                    memory for the session.
 *   withLabels(events, labels)       the events with humanLabel / labelWho filled in
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { labelCounts, type SoundLabel, type SoundLabelWho } from '@sleep-lab/core';
import { supabaseClient } from './data/supabase.ts';

export type { SoundLabel, SoundLabelWho };

export interface LabelEntry {
  label: SoundLabel;
  who: SoundLabelWho | null;
  /** What it was (migration 0034): bird, alarm, noise, movement, other …; null = not said. */
  category?: string | null;
  /** Free description typed under the clip (migration 0034). */
  note?: string | null;
}

export interface Labelling {
  /** Event id → label. */
  labels: ReadonlyMap<string, LabelEntry>;
  counts: { snore: number; notSnore: number; total: number };
  /** May this viewer label (a writer on real data, anyone in the simulator, and the server has migration 0030)? */
  canLabel: boolean;
  /** Plain-English problem (e.g. the migration isn't applied), or null. */
  error: string | null;
  /** Sets (or changes) a label; resolves to an error message or null. */
  setLabel: (eventId: string, label: SoundLabel, who?: SoundLabelWho | null) => Promise<string | null>;
  /** Sets what the sound was and/or a free description (a new label row counts as not snoring). */
  setNote: (eventId: string, category: string | null, note: string | null) => Promise<string | null>;
}

const NOT_YET = 'Labels aren’t on the server yet (migration 0030).';
const missing = (m: string) => /sound_labels|label_sound_event|does not exist|schema cache|could not find/i.test(m);

interface Store {
  maps: { real: Map<string, LabelEntry>; sim: Map<string, LabelEntry> };
  loaded: boolean;
  loading: boolean;
  missing: boolean;
  error: string | null;
  version: number;
  listeners: Set<() => void>;
}
const store: Store = { maps: { real: new Map(), sim: new Map() }, loaded: false, loading: false, missing: false, error: null, version: 0, listeners: new Set() };

function emit() {
  store.version++;
  for (const l of store.listeners) l();
}
const subscribe = (l: () => void) => {
  store.listeners.add(l);
  return () => store.listeners.delete(l);
};
const snapshot = () => store.version;

async function loadReal() {
  if (store.loaded || store.loading) return;
  store.loading = true;
  const map = new Map<string, LabelEntry>();
  let error: string | null = null;
  // Paged past PostgREST's 1000-row limit (at most 5000 labels).
  for (let from = 0; from < 5000; from += 1000) {
    const { data, error: e } = await supabaseClient().from('sound_labels').select('event_id,label,who,category,note').order('labelled_at', { ascending: false }).range(from, from + 999);
    if (e) {
      error = e.message;
      break;
    }
    for (const r of (data ?? []) as { event_id: number | string; label: SoundLabel; who: SoundLabelWho | null; category?: string | null; note?: string | null }[]) {
      const id = String(r.event_id);
      if (!map.has(id)) map.set(id, { label: r.label, who: r.who ?? null, category: r.category ?? null, note: r.note ?? null });
    }
    if ((data ?? []).length < 1000) break;
  }
  store.loading = false;
  store.loaded = true;
  if (error) {
    store.missing = missing(error);
    store.error = store.missing ? NOT_YET : error;
  } else {
    // Keep labels set while loading (optimistic) on top of what the server had.
    for (const [k, v] of store.maps.real) map.set(k, v);
    store.maps.real = map;
  }
  emit();
}

/** The shared label store (see the header). */
export function useSoundLabels(real: boolean, canWrite: boolean): Labelling {
  const version = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    if (real) void loadReal();
  }, [real]);
  const map = real ? store.maps.real : store.maps.sim;
  const setLabel = useCallback(
    async (eventId: string, label: SoundLabel, who: SoundLabelWho | null = null): Promise<string | null> => {
      const m = real ? store.maps.real : store.maps.sim;
      const before = m.get(eventId);
      // A different verdict clears "what was it"; the description stays.
      const next: LabelEntry = { label, who: label === 'snore' ? who : null, category: label === before?.label ? (before?.category ?? null) : null, note: before?.note ?? null };
      m.set(eventId, next);
      store.error = null;
      emit();
      if (!real) return null;
      const id = Number(eventId);
      if (!Number.isFinite(id)) return null;
      const { error } = await supabaseClient().rpc('label_sound_event', { p_event_id: id, p_label: label, p_who: next.who });
      if (!error) return null;
      // Put the old label back.
      if (before) m.set(eventId, before);
      else m.delete(eventId);
      store.missing = missing(error.message);
      store.error = store.missing ? NOT_YET : /not allowed/i.test(error.message) ? 'Only household members can label sounds.' : error.message;
      emit();
      return store.error;
    },
    [real],
  );
  const setNote = useCallback(
    async (eventId: string, category: string | null, note: string | null): Promise<string | null> => {
      const m = real ? store.maps.real : store.maps.sim;
      const before = m.get(eventId);
      const next: LabelEntry = { label: before?.label ?? 'not_snore', who: before?.who ?? null, category: category?.trim() || null, note: note?.trim() || null };
      m.set(eventId, next);
      store.error = null;
      emit();
      if (!real) return null;
      const id = Number(eventId);
      if (!Number.isFinite(id)) return null;
      const { error } = await supabaseClient().rpc('set_sound_note', { p_event_id: id, p_category: next.category, p_note: next.note });
      if (!error) return null;
      if (before) m.set(eventId, before);
      else m.delete(eventId);
      store.error = /not allowed/i.test(error.message) ? 'Only household members can label sounds.' : /set_sound_note|schema cache|could not find/i.test(error.message) ? 'Descriptions aren’t on the server yet (migration 0034).' : error.message;
      emit();
      return store.error;
    },
    [real],
  );
  return useMemo(
    () => ({
      labels: new Map(map),
      counts: labelCounts([...map.values()].map((v) => v.label)),
      canLabel: real ? canWrite && !store.missing : true,
      error: real ? store.error : null,
      setLabel,
      setNote,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, real, canWrite, setLabel, setNote],
  );
}

/** The events with the household's labels filled in (humanLabel / labelWho); the same array when nothing is labelled. */
export function withLabels<E extends { id: string; humanLabel?: SoundLabel | null; labelWho?: SoundLabelWho | null }>(events: readonly E[], labels: ReadonlyMap<string, LabelEntry>): E[] {
  if (!labels.size) return events as E[];
  return events.map((e) => {
    const l = labels.get(e.id);
    return l ? { ...e, humanLabel: l.label, labelWho: l.who } : e;
  });
}

/** "Labelled: 6 snore, 3 not" (null without labels). */
export function labelTally(c: { snore: number; notSnore: number; total: number }): string | null {
  if (!c.total) return null;
  const other = c.total - c.snore - c.notSnore;
  return `Labelled: ${c.snore} snore, ${c.notSnore} not${other ? `, ${other} other` : ''}`;
}
