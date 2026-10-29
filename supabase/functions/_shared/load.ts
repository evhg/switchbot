// Loads core-shaped data (curves, nights, room and body series) from Postgres.
import { DEFAULT_CURVE } from '../../../packages/core/src/curve.ts';
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

/** The nights row for `date`, created from DEFAULT_LIGHTS_OUT / DEFAULT_WAKE (ICT) when missing. */
export async function ensureNight(db: Db, date: string): Promise<NightRow> {
  const existing = must(await db.from('nights').select('*').eq('date', date).maybeSingle(), 'nights');
  if (existing) return existing as NightRow;
  const { lightsOut, wake } = defaultSchedule(date, optEnv('DEFAULT_LIGHTS_OUT') ?? '22:30', optEnv('DEFAULT_WAKE') ?? '06:30');
  const { data: def } = await db.from('curves').select('id').eq('is_default', true).maybeSingle();
  const row = { date, lights_out: iso(lightsOut), wake: iso(wake), curve_id: (def as { id?: string } | null)?.id ?? null };
  const ins = await db.from('nights').upsert(row, { onConflict: 'date', ignoreDuplicates: true });
  if (ins.error) throw new Error(`nights: ${ins.error.message}`);
  return must(await db.from('nights').select('*').eq('date', date).single(), 'nights') as NightRow;
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
}

export async function loadNight(db: Db, row: NightRow, opts: LoadNightOptions): Promise<Night> {
  const { from, to } = nightWindow(row.date);
  const [room, outdoor, ac, events, people] = await Promise.all([
    loadRoom(db, opts.deviceId, from, to, opts.roomBucketMin ?? 0),
    db.from('outdoor_readings').select('ts,temp_c,rh').gte('ts', iso(from)).lt('ts', iso(to)).order('ts').limit(1000),
    db.from('ac_commands').select('*').eq('night_date', row.date).order('ts'),
    opts.withEvents ? db.from('events').select('*').eq('night_date', row.date).order('start_ts') : Promise.resolve({ data: [], error: null }),
    Promise.all(opts.personIds.map((p) => loadPersonNight(db, p, row.date))),
  ]);
  return {
    date: row.date,
    lightsOut: Date.parse(row.lights_out),
    wake: Date.parse(row.wake),
    room,
    outdoor: (must(outdoor, 'outdoor_readings') as { ts: string; temp_c: number; rh: number }[]).map(rowToOutdoor),
    ac: effectiveCommands(must(ac, 'ac_commands') as AcCommandRow[]).map(rowToCommand),
    curveId: row.curve_id ?? DEFAULT_CURVE.id,
    events: (must(events, 'events') as EventRow[]).map(rowToEvent),
    people: people.filter((p): p is PersonNight => p !== null),
    tags: (row.tags ?? []) as Night['tags'],
  };
}
