// Loads core-shaped data (curves, nights, room and body series) from Postgres.
import { DEFAULT_CURVE, expectedSleepOnset } from '../../../packages/core/src/curve.ts';
import { typicalSleepOnset } from '../../../packages/core/src/metrics/onset.ts';
import type { Night, PersonNight, RoomReading, TemperatureCurve } from '../../../packages/core/src/types.ts';
import { optEnv } from './env.ts';
import {
  bucketToReading,
  type CurveRow,
  type EventRow,
  type NightRow,
  rowToCommand,
  rowToCurve,
  rowToEvent,
  rowToHr,
  rowToHrv,
  rowToOutdoor,
  rowToReading,
  rowSleepOnset,
  rowToSleep,
  rowToSpo2,
  type AcCommandRow,
  type SleepRow,
} from './rows.ts';
import { type Db, must, selectAll } from './supabase.ts';
import { addDays, defaultSchedule, ictAt, iso, MIN, nightWindow } from './time.ts';

export async function loadCurve(db: Db, id: string | null): Promise<TemperatureCurve> {
  const q = id ? db.from('curves').select('*').eq('id', id) : db.from('curves').select('*').eq('is_default', true);
  const { data } = await q.maybeSingle();
  return data ? rowToCurve(data as CurveRow) : DEFAULT_CURVE;
}

/** Default wake (ICT HH:MM) when a night has no row yet: 08:30 every day, unless DEFAULT_WAKE says otherwise. */
export const DEFAULT_WAKE_HHMM = '08:30';

/**
 * The nights row for `date`, created from DEFAULT_LIGHTS_OUT / DEFAULT_WAKE (ICT; default 22:00 → 08:30 every day)
 * when missing. A new night also gets its expected sleep onset from the watches (learnedSleepOnset) when there is
 * enough sleep data; otherwise sleep_onset stays null, which means lights-out + 60 min (23:00).
 */
export async function ensureNight(db: Db, date: string): Promise<NightRow> {
  const existing = must(await db.from('nights').select('*').eq('date', date).maybeSingle(), 'nights');
  if (existing) return existing as NightRow;
  const { lightsOut, wake } = defaultSchedule(date, optEnv('DEFAULT_LIGHTS_OUT') ?? '22:00', optEnv('DEFAULT_WAKE') ?? DEFAULT_WAKE_HHMM);
  const [{ data: def }, onset] = await Promise.all([
    db.from('curves').select('id').eq('is_default', true).maybeSingle(),
    learnedSleepOnset(db, lightsOut).catch((e) => {
      console.error('learnedSleepOnset', e instanceof Error ? e.message : String(e));
      return null;
    }),
  ]);
  const row = {
    date,
    lights_out: iso(lightsOut),
    wake: iso(wake),
    curve_id: (def as { id?: string } | null)?.id ?? null,
    sleep_onset: onset === null ? null : iso(onset),
  };
  const ins = await db.from('nights').upsert(row, { onConflict: 'date', ignoreDuplicates: true });
  if (ins.error) throw new Error(`nights: ${ins.error.message}`);
  return must(await db.from('nights').select('*').eq('date', date).single(), 'nights') as NightRow;
}

/**
 * Expected sleep onset for the night whose lights-out is `lightsOut`, learned from the household's recent main sleeps
 * (sleep_sessions, real data only, the 30 days before lights-out): core typicalSleepOnset = the later of the two
 * people's median onset over their last 14 main sleeps. Placed on this night's clock and clamped to lights-out …
 * lights-out + 3 h. null when there is not enough data (the night then uses lights-out + 60 min).
 */
export async function learnedSleepOnset(db: Db, lightsOut: number): Promise<number | null> {
  const { data, error } = await db.from('sleep_sessions').select('*')
    .neq('source', 'sim').gte('start_ts', iso(lightsOut - 30 * 24 * 60 * MIN)).lt('end_ts', iso(lightsOut)).order('start_ts').limit(1000);
  if (error) throw new Error(`sleep_sessions: ${error.message}`);
  const typical = typicalSleepOnset(((data ?? []) as SleepRow[]).map(rowToSleep), { before: lightsOut });
  if (!typical) return null;
  return expectedSleepOnset(lightsOut, onsetOnNight(lightsOut, typical.minuteOfDay));
}

/** Epoch ms of minute-of-day `minuteOfDay` (ICT) on the night of `lightsOut`: the first such moment after lights-out − 12 h. */
export function onsetOnNight(lightsOut: number, minuteOfDay: number): number {
  const ICT = 7 * 60 * MIN;
  const day = 24 * 60 * MIN;
  const from = lightsOut - 12 * 60 * MIN;
  const midnight = Math.floor((from + ICT) / day) * day - ICT;
  let t = midnight + minuteOfDay * MIN;
  while (t < from) t += day;
  return t;
}

export async function loadRoom(db: Db, deviceId: string, from: number, to: number, bucketMin = 0): Promise<RoomReading[]> {
  if (bucketMin > 0) {
    const rows = await selectAll<{ bucket: string; temp_c: number; rh: number; co2: number }>(
      (a, b) => db.rpc('readings_buckets', { p_from: iso(from), p_to: iso(to), p_minutes: bucketMin, p_device_id: deviceId }).range(a, b),
      'readings_buckets',
    );
    return rows.map(bucketToReading);
  }
  const rows = await selectAll<{ ts: string; temp_c: number; rh: number; co2: number; source: RoomReading['source'] }>(
    (a, b) =>
      db.from('readings').select('ts,temp_c,rh,co2,source').eq('device_id', deviceId).gte('ts', iso(from)).lt('ts', iso(to)).order('ts').range(a, b),
    'readings',
  );
  return rows.map(rowToReading);
}

type Obj = Record<string, unknown>;

/** First finite number under any of `keys` (depth-first, in key order). Daily payload shapes vary by type. */
export function findNumber(v: unknown, keys: string[]): number | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  for (const k of keys) {
    const x = (v as Obj)[k];
    if (typeof x === 'number' && Number.isFinite(x)) return x;
    if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x))) return Number(x);
  }
  for (const x of Object.values(v as Obj)) {
    const n = findNumber(x, keys);
    if (n !== undefined) return n;
  }
  return undefined;
}

async function dailyExtras(db: Db, personId: string, date: string): Promise<Pick<PersonNight, 'respRate' | 'tempDeviationC'>> {
  const { data } = await db.from('health_daily').select('data_type,value').eq('person_id', personId).eq('date', date);
  const out: Pick<PersonNight, 'respRate' | 'tempDeviationC'> = {};
  for (const r of (data ?? []) as { data_type: string; value: unknown }[]) {
    if (r.data_type === 'daily-sleep-temperature-derivations') {
      const n = findNumber(r.value, ['nightlyTemperatureCelsius']);
      const b = findNumber(r.value, ['baselineTemperatureCelsius']);
      if (n !== undefined && b !== undefined) out.tempDeviationC = Math.round((n - b) * 100) / 100;
    } else if (r.data_type === 'daily-respiratory-rate' || r.data_type === 'respiratory-rate-sleep-summary') {
      const v = findNumber(r.value, ['breathsPerMinute', 'fullSleepBreathsPerMinute', 'averageBreathsPerMinute']);
      if (v !== undefined && out.respRate === undefined) out.respRate = v;
    }
  }
  return out;
}

type Vitals = Pick<PersonNight, 'steps' | 'restingHr' | 'hrvDailyMs' | 'deepRmssdMs'>;

/** health_vitals_daily (0003) for one night: steps from the day before the wake date, resting HR / daily HRV from the wake date. */
async function dailyVitals(db: Db, personId: string, date: string): Promise<Vitals> {
  const { data } = await db.from('health_vitals_daily').select('date,steps,resting_hr,hrv_daily_ms,deep_rmssd_ms')
    .eq('person_id', personId).in('date', [addDays(date, -1), date]);
  return vitalsFromRows((data ?? []) as Obj[], date);
}

/** Shared with the PWA's reader (apps/web/lib/data/supabase.ts vitalsFor). Postgres numerics may arrive as strings. */
export function vitalsFromRows(rows: Obj[], date: string): Vitals {
  const n = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  const prev = rows.find((r) => r.date === addDays(date, -1));
  const same = rows.find((r) => r.date === date);
  const out: Vitals = {};
  if (Number.isFinite(n(prev?.steps))) out.steps = n(prev?.steps);
  if (Number.isFinite(n(same?.resting_hr))) out.restingHr = n(same?.resting_hr);
  if (Number.isFinite(n(same?.hrv_daily_ms))) out.hrvDailyMs = n(same?.hrv_daily_ms);
  if (Number.isFinite(n(same?.deep_rmssd_ms))) out.deepRmssdMs = n(same?.deep_rmssd_ms);
  return out;
}

/** Main sleep session ending in the night's window, with its HR / HRV / SpO2 series. */
export async function loadPersonNight(db: Db, personId: string, date: string): Promise<PersonNight | null> {
  const from = ictAt(addDays(date, -1), '18:00');
  const to = ictAt(date, '14:00');
  const sessions = must(
    await db.from('sleep_sessions').select('*').eq('person_id', personId).gte('end_ts', iso(from)).lt('end_ts', iso(to)),
    'sleep_sessions',
  ) as SleepRow[];
  const main = sessions
    .map(rowToSleep)
    .sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
  if (!main) return null;
  const a = iso(main.start - 30 * MIN);
  const b = iso(main.end + 30 * MIN);
  const [hr, hrv, spo2, extras, vitals] = await Promise.all([
    selectAll<{ ts: string; bpm: number }>(
      (x, y) => db.from('health_hr').select('ts,bpm').eq('person_id', personId).gte('ts', a).lte('ts', b).order('ts').range(x, y),
      'health_hr',
    ),
    selectAll<{ ts: string; rmssd_ms: number }>(
      (x, y) => db.from('health_hrv').select('ts,rmssd_ms').eq('person_id', personId).gte('ts', a).lte('ts', b).order('ts').range(x, y),
      'health_hrv',
    ),
    selectAll<{ ts: string; pct: number }>(
      (x, y) => db.from('health_spo2').select('ts,pct').eq('person_id', personId).gte('ts', a).lte('ts', b).order('ts').range(x, y),
      'health_spo2',
    ),
    dailyExtras(db, personId, date),
    dailyVitals(db, personId, date),
  ]);
  return { personId, sleep: main, hr: hr.map(rowToHr), hrv: hrv.map(rowToHrv), spo2: spo2.map(rowToSpo2), ...extras, ...vitals };
}

/**
 * Commands that (probably) reached the AC: failed sends are dropped, and dry-run rows are dropped once the night
 * has live ones. A dry-run-only night (Phase 0, sim seed) keeps its dry-run log so the plan stays visible.
 */
export function effectiveCommands<T extends Pick<AcCommandRow, 'dry_run' | 'sent_ok'>>(rows: T[]): T[] {
  const ok = rows.filter((c) => c.sent_ok !== false);
  return ok.some((c) => !c.dry_run) ? ok.filter((c) => !c.dry_run) : ok;
}

export interface LoadNightOptions {
  deviceId: string;
  personIds: string[];
  /** 0 = raw 1-min readings; >0 = readings_buckets() at that resolution (cheaper for history). */
  roomBucketMin?: number;
  /** Include stored events (the report recomputes them for the target night). */
  withEvents?: boolean;
  /** Room readings already loaded (e.g. cleaned by the night analysis); skips the readings query. */
  room?: RoomReading[];
}

export async function loadNight(db: Db, row: NightRow, opts: LoadNightOptions): Promise<Night> {
  const { from, to } = nightWindow(row.date);
  const [room, outdoor, ac, events, people] = await Promise.all([
    opts.room ? Promise.resolve(opts.room) : loadRoom(db, opts.deviceId, from, to, opts.roomBucketMin ?? 0),
    db.from('outdoor_readings').select('ts,temp_c,rh').gte('ts', iso(from)).lt('ts', iso(to)).order('ts').limit(1000),
    db.from('ac_commands').select('*').eq('night_date', row.date).order('ts'),
    opts.withEvents ? db.from('events').select('*').eq('night_date', row.date).order('start_ts') : Promise.resolve({ data: [], error: null }),
    Promise.all(opts.personIds.map((p) => loadPersonNight(db, p, row.date))),
  ]);
  const acRows = must(ac, 'ac_commands') as AcCommandRow[];
  return {
    date: row.date,
    // Run by hand = no live command was sent (none, or dry-run logs only): scored against the comfort target.
    manual: !acRows.some((c) => !c.dry_run && c.sent_ok !== false),
    lightsOut: Date.parse(row.lights_out),
    wake: Date.parse(row.wake),
    ...(rowSleepOnset(row) !== undefined ? { sleepOnset: rowSleepOnset(row)! } : {}),
    room,
    outdoor: (must(outdoor, 'outdoor_readings') as { ts: string; temp_c: number; rh: number }[]).map(rowToOutdoor),
    ac: effectiveCommands(acRows).map(rowToCommand),
    curveId: row.curve_id ?? DEFAULT_CURVE.id,
    events: (must(events, 'events') as EventRow[]).map(rowToEvent),
    people: people.filter((p): p is PersonNight => p !== null),
    tags: (row.tags ?? []) as Night['tags'],
  };
}
