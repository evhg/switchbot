'use client';
/**
 * Camera activity (System › Camera): today's sightings from public.camera_events (migration 0022), posted by the Mac
 * relay through the camera-event Edge Function. Labels only: a household person ('a', 'b'), a consenting guest's
 * label, 'unknown' (a face that matched nobody) or 'person' (a body, no face).
 *
 * Real when signed in as a household member and the data source isn't forced to Simulated; otherwise a few sample
 * sightings (sampleCameraEvents) up to now.
 */
import { useEffect, useState } from 'react';
import { PERSON_LABEL, UNKNOWN_LABEL } from '@sleep-lab/core';
import { useAuth } from './auth.tsx';
import { useData } from './data/context.tsx';
import { supabaseClient } from './data/supabase.ts';
import { HOUR, MIN, ictDate, ictMidnight } from './format.ts';

export interface CameraSighting {
  id: string;
  ts: number;
  camera: string;
  label: string;
  personId: string | null;
  confidence: number | null;
  activity: string | null;
  durationS: number | null;
  sample?: boolean;
}

type Row = Record<string, unknown>;
const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN);
const numOrNull = (v: unknown) => (Number.isFinite(num(v)) ? num(v) : null);
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

function toSighting(r: Row): CameraSighting {
  return {
    id: String(r.id),
    ts: Date.parse(String(r.ts)),
    camera: str(r.camera) ?? 'living',
    label: str(r.label) ?? UNKNOWN_LABEL,
    personId: str(r.person_id),
    confidence: numOrNull(r.confidence),
    activity: str(r.activity),
    durationS: numOrNull(r.duration_s),
  };
}

/** Who a sighting shows: the person's name, the guest label, "Unknown person" or "Someone" (no face). */
export function sightingWho(e: Pick<CameraSighting, 'label' | 'personId'>, nameOf: (id: string) => string): string {
  if (e.personId) return nameOf(e.personId);
  if (e.label === UNKNOWN_LABEL) return 'Unknown person';
  if (e.label === PERSON_LABEL) return 'Someone';
  return e.label;
}

/** Plausible sightings for the simulator: today, up to now, newest first. */
export function sampleCameraEvents(now = Date.now()): CameraSighting[] {
  const at = (h: number, m = 0) => ictMidnight(ictDate(now)) + h * HOUR + m * MIN;
  const ev = (id: string, ts: number, label: string, activity: string | null, durationS: number | null, confidence: number | null): CameraSighting => ({
    id, ts, camera: 'living', label, personId: label === 'a' || label === 'b' ? label : null, confidence, activity, durationS, sample: true,
  });
  return [
    ev('c1', at(7, 42), 'b', 'kitchen', 540, 0.93),
    ev('c2', at(8, 5), 'a', 'dining', 1260, 0.9),
    ev('c3', at(9, 10), 'b', 'desk', 7200, 0.95),
    ev('c4', at(10, 30), 'person', 'kitchen', 90, null),
    ev('c5', at(12, 15), 'a', 'sofa', 1800, 0.88),
    ev('c6', at(14, 2), 'b', 'desk', 5400, 0.94),
    ev('c7', at(17, 20), 'a', 'kitchen', 900, 0.86),
    ev('c8', at(19, 5), 'b', 'sofa', 3600, 0.91),
  ]
    .filter((e) => e.ts <= now)
    .sort((a, b) => b.ts - a.ts);
}

/** Today's sightings (ICT), newest first; null while loading. */
export function useCameraActivity(): { real: boolean; events: CameraSighting[] | null; error: string | null } {
  const auth = useAuth();
  const { mode } = useData();
  const real = auth.status === 'signed-in' && !!auth.probe?.member && mode !== 'sim';
  const [events, setEvents] = useState<CameraSighting[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    if (!real) {
      setEvents(sampleCameraEvents());
      return;
    }
    setEvents(null);
    const since = new Date(ictMidnight(ictDate(Date.now()))).toISOString();
    supabaseClient()
      .from('camera_events')
      .select('id,ts,camera,label,person_id,confidence,activity,duration_s')
      .eq('hidden', false)
      .gte('ts', since)
      .order('ts', { ascending: false })
      .limit(200)
      .then(({ data, error: e }) => {
        if (!alive) return;
        if (e) {
          // Before migration 0022 the table doesn't exist: an empty timeline with the reason.
          setError(/does not exist|schema cache/i.test(e.message) ? 'Camera activity isn’t on the server yet (migration 0022).' : e.message);
          setEvents([]);
          return;
        }
        setEvents(((data ?? []) as Row[]).map(toSighting));
      });
    return () => {
      alive = false;
    };
  }, [real]);

  return { real, events, error };
}
