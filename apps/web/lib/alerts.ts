'use client';
/**
 * Phone alerts (System › Alerts; migration 0026, supabase/functions/alerts):
 *
 *   useAlerts(enabled, nonce)   household_settings.alerts (on/off per kind), each person's battery estimate from
 *                               public.battery_log (core estimateDrain: "83 %, ~5 days left") and the last alert of
 *                               each kind (public.alert_state); undefined while loading. Not a member: sample data.
 *   setAlerts(patch)            the writers' RPC set_alerts (owner / member); returns an error message or null
 *
 * The decisions themselves live in @sleep-lab/core (src/alerts); the function sends the pushes.
 */
import { useEffect, useState } from 'react';
import { DEFAULT_ALERT_SETTINGS, estimateDrain, parseAlertSettings, type AlertSettings, type BatteryReading, type DrainEstimate } from '@sleep-lab/core';
import { supabaseClient } from './data/supabase.ts';
import { DAY, HOUR } from './format.ts';

type Row = Record<string, unknown>;

export const ALERT_PEOPLE = ['a', 'b'] as const;

export interface SentAlert {
  key: string;
  kind: 'battery' | 'stale' | 'listener';
  personId: string | null;
  sentAt: number;
  body: string | null;
}

export interface AlertsData {
  settings: AlertSettings;
  /** false = alerts couldn't be read (not installed yet or an error): settings are the fallback, nothing is sent. */
  available: boolean;
  /** By person id; null = no battery readings yet. */
  batteries: Record<string, DrainEstimate | null>;
  /** Newest first. */
  sent: SentAlert[];
}

/** A server message that means "migration 0026 isn't applied yet". */
const missing = (m: string) => /does not exist|schema cache|could not find/i.test(m);
export const NOT_YET = 'Alerts aren’t on the server yet (migration 0026).';

function toSent(r: Row): SentAlert | null {
  const key = String(r.key ?? '');
  const at = typeof r.last_sent_at === 'string' ? Date.parse(r.last_sent_at) : NaN;
  if (!Number.isFinite(at)) return null;
  const [kind, person] = key.split(':');
  if (kind !== 'battery' && kind !== 'stale' && kind !== 'listener') return null;
  const data = (r.data ?? {}) as Row;
  return { key, kind, personId: person ?? null, sentAt: at, body: typeof data.body === 'string' ? data.body : null };
}

/** Plausible numbers for the simulator / signed-out view, so the page is never empty. */
export function sampleAlerts(now = Date.now()): AlertsData {
  const hours = (start: number, level: number, rate: number, n: number): BatteryReading[] =>
    Array.from({ length: n }, (_, i) => ({ ts: now - (n - 1 - i) * HOUR - start, level: Math.round(level - rate * i) }));
  return {
    settings: DEFAULT_ALERT_SETTINGS,
    available: false,
    batteries: { a: estimateDrain(hours(0, 92, 0.7, 12), now), b: estimateDrain(hours(0, 34, 1.1, 10), now) },
    sent: [],
  };
}

export function useAlerts(enabled: boolean, nonce = 0): { data: AlertsData | undefined; error: string | null } {
  const [res, setRes] = useState<{ data: AlertsData | undefined; error: string | null }>({ data: undefined, error: null });
  useEffect(() => {
    if (!enabled) return setRes({ data: sampleAlerts(), error: null });
    let alive = true;
    const c = supabaseClient();
    const now = Date.now();
    Promise.all([
      c.from('household_settings').select('alerts').eq('id', 1).maybeSingle(),
      c.from('alert_state').select('key,last_sent_at,data'),
      c
        .from('battery_log')
        .select('person_id,ts,level')
        .gte('ts', new Date(now - 14 * DAY).toISOString())
        .order('ts', { ascending: false })
        .limit(1000),
    ]).then(([s, st, bl]) => {
      if (!alive) return;
      const err = s.error ?? st.error ?? bl.error;
      if (err) return setRes({ data: { settings: DEFAULT_ALERT_SETTINGS, available: false, batteries: { a: null, b: null }, sent: [] }, error: missing(err.message) || /alerts/.test(err.message) ? NOT_YET : err.message });
      const byPerson = new Map<string, BatteryReading[]>();
      for (const r of (bl.data ?? []) as Row[]) {
        const id = String(r.person_id);
        const list = byPerson.get(id) ?? [];
        list.push({ ts: Date.parse(String(r.ts)), level: Number(r.level) });
        byPerson.set(id, list);
      }
      const batteries: Record<string, DrainEstimate | null> = {};
      for (const id of ALERT_PEOPLE) batteries[id] = estimateDrain(byPerson.get(id) ?? [], now);
      const sent = ((st.data ?? []) as Row[])
        .map(toSent)
        .filter((x): x is SentAlert => x !== null)
        .sort((a, b) => b.sentAt - a.sentAt);
      setRes({ data: { settings: parseAlertSettings((s.data as Row | null)?.alerts), available: true, batteries, sent }, error: null });
    });
    return () => {
      alive = false;
    };
  }, [enabled, nonce]);
  return res;
}

/** Turns alert kinds on or off (set_alerts, migration 0026). */
export async function setAlerts(patch: Partial<Record<'battery' | 'stale_sync' | 'listener', boolean>>): Promise<string | null> {
  const { error } = await supabaseClient().rpc('set_alerts', { p: patch });
  if (!error) return null;
  if (missing(error.message)) return NOT_YET;
  if (/not allowed|permission|denied/i.test(error.message)) return 'Your household role is read-only.';
  return error.message;
}
