'use client';
/**
 * Tonight: schedule, presence and the pre-cool decision (decided 2026-10-29: bedtime 22:00 every day, pre-cool at 21:30
 * only when someone is home). One hook for System › Tonight's plan, System › Presence and the System root.
 *
 * Signed in as a household member: reads tonight's `nights` row (lights out, wake, presence_override, precool_status /
 * precool_reason written by the ac-curve function), `presence_latest` (iPhone Shortcuts events) and the last hour of CO₂;
 * writes the wake time with the existing set_night RPC and "Home tonight / Away tonight" with set_presence_override
 * (migration 0009). Otherwise (simulator, signed out) the same values live on this device.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from './auth.tsx';
import { functionsUrl, supabaseClient } from './data/supabase.ts';
import { addDays, hm, ictDate, ictHour, MIN } from './format.ts';
import { usePref } from './prefs.ts';

/** Lights out every day, weekends included (minute of day, ICT). */
export const DEFAULT_LIGHTS_OUT = 22 * 60;
/** Wake until set: 06:30. */
export const DEFAULT_WAKE = 6 * 60 + 30;
/** The pre-cool starts this long before lights out (the default curve's first phase). */
export const PRECOOL_BEFORE_MIN = 30;
/** A late arrival still starts the aircon until lights out + 3 h (supabase/functions/_shared/presence.ts). */
export const START_UNTIL_MIN = 180;
/** A 'home' signal older than this is stale: it only starts the pre-cool together with rising CO₂ (backend rule). */
export const STALE_HOME_H = 48;

export type PresenceState = 'home' | 'away';
export type Override = PresenceState | null;

export interface PersonPresence {
  personId: string;
  name: string;
  state: PresenceState;
  at: number;
}

export interface TonightNight {
  date: string;
  lightsOut: number;
  wake: number;
  override: Override;
  acEnabled: boolean;
  tags: string[];
  precoolStatus: string | null;
  precoolReason: string | null;
  precoolAt: number | null;
}

export interface Tonight {
  /** Wake date of tonight's night (ICT); null until mounted. */
  date: string | null;
  /** Real backend (signed-in household member) vs. this device only. */
  live: boolean;
  canWrite: boolean;
  loading: boolean;
  error: string | null;
  /** Minute of day. */
  lightsOutMin: number;
  wakeMin: number;
  override: Override;
  presence: PersonPresence[];
  /** Home / Away / Unknown for tonight, with a sentence ("Erik home since 18:42"). */
  status: { state: 'home' | 'away' | 'unknown'; text: string };
  /** The pre-cool line: what will happen / happened and why. */
  precool: { tone: 'on' | 'off' | 'alert'; text: string };
  /** CO₂ rising in the evening while nobody is marked home: a hint only, it never starts the aircon. */
  co2Hint: { rise: number; ppm: number } | null;
  setWake: (min: number) => Promise<string | null>;
  setOverride: (o: Override) => Promise<string | null>;
  refresh: () => void;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const hhmm = (min: number) => `${pad(Math.floor((((min % 1440) + 1440) % 1440) / 60))}:${pad(((min % 60) + 60) % 60)}`;
export const parseHhmm = (s: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h < 24 && mi < 60 ? h * 60 + mi : null;
};
/** Epoch ms of minute-of-day `min` (ICT) on `date`. */
const ictAt = (date: string, min: number) => Date.parse(`${date}T${hhmm(min)}:00+07:00`);
const minuteOf = (ts: number) => {
  const d = new Date(ts + 7 * 60 * MIN);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

/** The night tags and presence apply to: from noon on, the night ending tomorrow morning. */
export const tonightDate = (now = Date.now()) => (ictHour(now) >= 12 ? addDays(ictDate(now), 1) : ictDate(now));

/** Lights out (evening before `date`) and wake (on `date`) as epoch ms. */
export function nightTimes(date: string, lightsOutMin: number, wakeMin: number) {
  const lo = lightsOutMin >= 12 * 60 ? ictAt(addDays(date, -1), lightsOutMin) : ictAt(date, lightsOutMin);
  return { lightsOut: lo, wake: ictAt(date, wakeMin) };
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** "18:42" for today (ICT) or the last 12 h, else "Mon 18:42": an old signal must never look current. */
export function since(at: number, now: number): string {
  const sameDay = ictDate(at) === ictDate(now);
  return sameDay || (now - at >= 0 && now - at < 12 * 60 * MIN) ? hm(at) : `${WD[new Date(at + 7 * 60 * MIN).getUTCDay()]} ${hm(at)}`;
}
const isStale = (p: PersonPresence, now: number) => now - p.at > STALE_HOME_H * 60 * MIN;
const name = (p: PersonPresence, now: number) => `${p.name} ${p.state} since ${since(p.at, now)}`;

/** Mirror of the backend's presence gate (supabase/functions/_shared/presence.ts) for the app's status lines. */
export function tonightStatus(override: Override, tags: readonly string[], presence: readonly PersonPresence[], now = Date.now()): Tonight['status'] {
  if (override === 'away' || tags.includes('travel')) return { state: 'away', text: 'Away tonight (set in the app)' };
  if (override === 'home') return { state: 'home', text: 'Home tonight (set in the app)' };
  const home = presence.filter((p) => p.state === 'home');
  const fresh = home.filter((p) => !isStale(p, now));
  if (fresh.length) return { state: 'home', text: fresh.map((p) => name(p, now)).join(' · ') };
  if (home.length) {
    return { state: 'unknown', text: `${home.map((p) => name(p, now)).join(' · ')}. Signal older than ${STALE_HOME_H} h: tap “Home tonight” if you are` };
  }
  if (presence.length) return { state: 'away', text: presence.map((p) => name(p, now)).join(' · ') };
  return { state: 'unknown', text: 'No presence signal yet' };
}

export function precoolLine(o: {
  now: number;
  lightsOut: number;
  status: Tonight['status'];
  acEnabled: boolean;
  server: { status: string | null; reason: string | null; at: number | null };
}): Tonight['precool'] {
  const { now, lightsOut, status, acEnabled, server } = o;
  const start = lightsOut - PRECOOL_BEFORE_MIN * MIN;
  const until = lightsOut + START_UNTIL_MIN * MIN;
  if (!acEnabled) return { tone: 'off', text: 'Aircon switched off for tonight' };
  if (status.state === 'away') return status.text.startsWith('Away tonight') ? { tone: 'off', text: 'No pre-cool: away tonight' } : now < start
      ? { tone: 'off', text: `Pre-cool at ${hm(start)} only if someone is home by then (until ${hm(until)})` }
      : now <= until
        ? { tone: 'alert', text: `Pre-cool waiting: nobody home. It starts if someone arrives before ${hm(until)}` }
        : { tone: 'off', text: 'Pre-cool skipped: nobody came home in time' };
  if (server.status === 'started' || server.status === 'override') return { tone: 'on', text: `Pre-cool started at ${server.at ? hm(server.at) : hm(start)}: ${server.reason ?? 'someone home'}` };
  if (now < start) {
    return status.state === 'home'
      ? { tone: 'on', text: `Pre-cool at ${hm(start)}: someone is home` }
      : { tone: 'off', text: `Pre-cool at ${hm(start)} only if someone is home (${status.text === 'No presence signal yet' ? 'no presence signal yet' : 'home signal stale'})` };
  }
  if (server.status === 'waiting' || server.status === 'skipped') {
    const why = server.reason ?? 'nobody home';
    return server.status === 'skipped' || now > until
      ? { tone: 'off', text: `Pre-cool skipped: ${why}` }
      : { tone: 'alert', text: `Pre-cool skipped so far: ${why}. It starts if someone arrives before ${hm(until)}` };
  }
  if (now > until) return { tone: 'off', text: 'Too late to start tonight' };
  return status.state === 'home'
    ? { tone: 'on', text: `Pre-cool due now: ${status.text}` }
    : { tone: 'alert', text: `Pre-cool skipped: nobody home (${status.text === 'No presence signal yet' ? 'no presence signal' : 'home signal stale'})` };
}

/** Evening CO₂ rising noticeably in the last hour: probably someone in the room. */
export function co2Rising(readings: readonly { ts: number; co2: number }[], now: number): { rise: number; ppm: number } | null {
  const last = readings.filter((r) => r.ts > now - 10 * MIN && Number.isFinite(r.co2));
  const first = readings.filter((r) => r.ts <= now - 45 * MIN && r.ts > now - 65 * MIN && Number.isFinite(r.co2));
  if (last.length < 3 || first.length < 3) return null;
  const m = (xs: readonly { co2: number }[]) => xs.reduce((a, r) => a + r.co2, 0) / xs.length;
  const rise = m(last) - m(first);
  return rise >= 120 && m(last) >= 550 ? { rise: Math.round(rise), ppm: Math.round(m(last)) } : null;
}

type Row = Record<string, unknown>;
const ms = (v: unknown) => (typeof v === 'string' ? Date.parse(v) : NaN);

export function useTonight(people: readonly { id: string; name: string }[]): Tonight {
  const auth = useAuth();
  const live = auth.status === 'signed-in' && !!auth.probe?.member;
  const canWrite = live && (auth.probe?.role === 'owner' || auth.probe?.role === 'member');
  const [date, setDate] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setDate(tonightDate());
    const t = window.setInterval(() => {
      setNow(Date.now());
      setDate(tonightDate());
    }, 60_000);
    return () => window.clearInterval(t);
  }, []);

  // This device (simulator / signed out).
  const [localWake, setLocalWake] = usePref<number>('wakeMin', DEFAULT_WAKE);
  const [localOverride, setLocalOverride] = usePref<Record<string, Override>>('presenceOverride', {});

  const [night, setNight] = useState<TonightNight | null>(null);
  const [presenceRows, setPresenceRows] = useState<Row[]>([]);
  const [co2, setCo2] = useState<{ ts: number; co2: number }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!live || !date) return;
    let off = false;
    const db = supabaseClient();
    setLoading(true);
    Promise.all([
      db.from('nights').select('date,lights_out,wake,tags,ac_enabled,presence_override,precool_status,precool_reason,precool_at').eq('date', date).maybeSingle(),
      db.from('presence_latest').select('person_id,state,at'),
      db.from('readings').select('ts,co2').neq('source', 'sim').gte('ts', new Date(Date.now() - 70 * MIN).toISOString()).order('ts').limit(200),
    ])
      .then(([n, p, r]) => {
        if (off) return;
        if (n.error) throw new Error(n.error.message);
        const row = n.data as Row | null;
        setNight(
          row
            ? {
                date,
                lightsOut: ms(row.lights_out),
                wake: ms(row.wake),
                override: row.presence_override === 'home' || row.presence_override === 'away' ? row.presence_override : null,
                acEnabled: row.ac_enabled !== false,
                tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
                precoolStatus: typeof row.precool_status === 'string' ? row.precool_status : null,
                precoolReason: typeof row.precool_reason === 'string' ? row.precool_reason : null,
                precoolAt: typeof row.precool_at === 'string' ? ms(row.precool_at) : null,
              }
            : null,
        );
        setPresenceRows(p.error ? [] : ((p.data ?? []) as Row[]));
        setCo2(r.error ? [] : ((r.data ?? []) as Row[]).map((x) => ({ ts: ms(x.ts), co2: Number(x.co2) })));
        setError(p.error ? p.error.message : null);
      })
      .catch((e: unknown) => !off && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !off && setLoading(false));
    return () => {
      off = true;
    };
  }, [live, date, nonce]);

  const presence = useMemo<PersonPresence[]>(
    () =>
      live
        ? presenceRows
            .filter((r) => r.state === 'home' || r.state === 'away')
            .map((r) => ({
              personId: String(r.person_id),
              name: people.find((p) => p.id === r.person_id)?.name ?? String(r.person_id),
              state: r.state as PresenceState,
              at: ms(r.at),
            }))
        : [],
    [live, presenceRows, people],
  );

  const lightsOutMin = live && night ? minuteOf(night.lightsOut) : DEFAULT_LIGHTS_OUT;
  const wakeMin = live && night ? minuteOf(night.wake) : live ? DEFAULT_WAKE : localWake;
  const override: Override = live ? night?.override ?? null : date ? localOverride[date] ?? null : null;
  const tags = live ? night?.tags ?? [] : [];
  const status = tonightStatus(override, tags, presence, now);
  const times = date ? nightTimes(date, lightsOutMin, wakeMin) : null;
  const precool = times
    ? precoolLine({
        now,
        lightsOut: times.lightsOut,
        status,
        acEnabled: live ? night?.acEnabled ?? true : true,
        server: { status: live ? night?.precoolStatus ?? null : null, reason: live ? night?.precoolReason ?? null : null, at: live ? night?.precoolAt ?? null : null },
      })
    : { tone: 'off' as const, text: '' };
  const evening = times ? now >= times.lightsOut - 4 * 60 * MIN && now <= times.lightsOut + START_UNTIL_MIN * MIN : false;
  const co2Hint = live && evening && status.state !== 'home' && override !== 'away' ? co2Rising(co2, now) : null;

  const setWake = useCallback(
    async (min: number): Promise<string | null> => {
      if (!date) return 'Not ready yet.';
      if (!live) {
        setLocalWake(min);
        return null;
      }
      if (!canWrite) return 'Your household role is read-only.';
      const t = nightTimes(date, lightsOutMin, min);
      const { error: e } = await supabaseClient().rpc('set_night', { p_date: date, p_lights_out: new Date(t.lightsOut).toISOString(), p_wake: new Date(t.wake).toISOString() });
      if (e) return e.message;
      refresh();
      return null;
    },
    [date, live, canWrite, lightsOutMin, setLocalWake, refresh],
  );

  const setOverride = useCallback(
    async (o: Override): Promise<string | null> => {
      if (!date) return 'Not ready yet.';
      if (!live) {
        setLocalOverride((st) => ({ ...st, [date]: o }));
        return null;
      }
      if (!canWrite) return 'Your household role is read-only.';
      const { error: e } = await supabaseClient().rpc('set_presence_override', { p_date: date, p_state: o });
      if (e) return e.message;
      refresh();
      return null;
    },
    [date, live, canWrite, setLocalOverride, refresh],
  );

  return { date, live, canWrite, loading, error, lightsOutMin, wakeMin, override, presence, status, precool, co2Hint, setWake, setOverride, refresh };
}

// ───────────────────────────── presence tokens (System › Presence) ─────────────────────────────

export interface TokenStatus {
  personId: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export const presenceUrl = () => `${functionsUrl()}/presence`;

export function usePresenceTokens(enabled: boolean): { tokens: TokenStatus[] | null; error: string | null; refresh: () => void } {
  const [tokens, setTokens] = useState<TokenStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let off = false;
    supabaseClient()
      .rpc('presence_token_status')
      .then(({ data, error: e }) => {
        if (off) return;
        if (e) return setError(e.message);
        setTokens(((data ?? []) as Row[]).map((r) => ({ personId: String(r.person_id), createdAt: ms(r.created_at), lastUsedAt: typeof r.last_used_at === 'string' ? ms(r.last_used_at) : null })));
      });
    return () => {
      off = true;
    };
  }, [enabled, nonce]);
  return { tokens, error, refresh: () => setNonce((n) => n + 1) };
}

/** Creates or replaces the person's token; the plain token is returned only here, once. */
export async function rotatePresenceToken(personId: string): Promise<{ token: string } | { error: string }> {
  const { data, error } = await supabaseClient().rpc('rotate_presence_token', { p_person_id: personId });
  if (error) {
    if (/own person/i.test(error.message)) return { error: 'Only that person or the household owner can change this token.' };
    return { error: /not allowed/i.test(error.message) ? 'Your household role is read-only.' : error.message };
  }
  return typeof data === 'string' ? { token: data } : { error: 'No token returned.' };
}
