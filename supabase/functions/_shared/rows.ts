// Row shapes of supabase/migrations/0001_init.sql and mappers to/from the core types.
// Runtime-neutral (no Deno globals): scripts/seed-supabase.ts imports it from Node too.
import type { AcCommand, AcState, CurvePhase, HrSample, HrvSample, Ms, OutdoorReading, RoomEvent, RoomReading, SleepSession, Spo2Sample, StageSegment, TemperatureCurve } from '../../../packages/core/src/types.ts';

const iso = (ms: Ms) => new Date(ms).toISOString();
const ms = (s: string) => Date.parse(s);

export interface ReadingRow {
  device_id: string;
  ts: string;
  temp_c: number;
  rh: number;
  co2: number;
  source: RoomReading['source'];
}

export function readingToRow(deviceId: string, r: RoomReading): ReadingRow {
  return { device_id: deviceId, ts: iso(r.ts), temp_c: r.tempC, rh: r.rh, co2: Math.round(r.co2), source: r.source };
}

export function rowToReading(r: Pick<ReadingRow, 'ts' | 'temp_c' | 'rh' | 'co2'> & { source?: RoomReading['source'] }): RoomReading {
  return { ts: ms(r.ts), tempC: r.temp_c, rh: r.rh, co2: r.co2, source: r.source ?? 'poll' };
}

/** readings_buckets() rows (bucket instead of ts). */
export function bucketToReading(r: { bucket: string; temp_c: number; rh: number; co2: number }): RoomReading {
  return { ts: ms(r.bucket), tempC: r.temp_c, rh: r.rh, co2: r.co2, source: 'poll' };
}

export function outdoorToRow(o: OutdoorReading, source = 'manual') {
  return { ts: iso(o.ts), temp_c: o.tempC, rh: o.rh, source };
}

export function rowToOutdoor(r: { ts: string; temp_c: number; rh: number }): OutdoorReading {
  return { ts: ms(r.ts), tempC: r.temp_c, rh: r.rh };
}

export interface AcCommandRow {
  id?: number;
  device_id: string;
  night_date: string | null;
  ts: string;
  state: AcState;
  via: AcCommand['via'];
  button: string | null;
  reason: string;
  landed: boolean | null;
  dry_run?: boolean;
  sent_ok?: boolean | null;
  error?: string | null;
}

export function commandToRow(deviceId: string, nightDate: string | null, c: AcCommand): AcCommandRow {
  return {
    device_id: deviceId,
    night_date: nightDate,
    ts: iso(c.ts),
    state: c.state,
    via: c.via,
    button: c.button ?? null,
    reason: c.reason,
    landed: c.landed ?? null,
  };
}

export function rowToCommand(r: AcCommandRow): AcCommand {
  const c: AcCommand = { ts: ms(r.ts), state: r.state, via: r.via, reason: r.reason, landed: r.landed };
  if (r.button) c.button = r.button;
  return c;
}

export interface EventRow {
  night_date: string | null;
  kind: RoomEvent['kind'];
  start_ts: string;
  end_ts: string | null;
  confidence: number;
  detail: Record<string, number | string>;
  source: 'detector' | 'manual' | 'sim_truth' | 'controller';
}

export function eventToRow(nightDate: string | null, e: RoomEvent, source: EventRow['source']): EventRow {
  return {
    night_date: nightDate,
    kind: e.kind,
    start_ts: iso(e.start),
    end_ts: e.end === undefined ? null : iso(e.end),
    confidence: Math.min(1, Math.max(0, e.confidence)),
    detail: e.detail ?? {},
    source,
  };
}

export function rowToEvent(r: EventRow): RoomEvent {
  const e: RoomEvent = { kind: r.kind, start: ms(r.start_ts), confidence: r.confidence };
  if (r.end_ts) e.end = ms(r.end_ts);
  if (r.detail && Object.keys(r.detail).length) e.detail = r.detail;
  return e;
}

export interface CurveRow {
  id: string;
  name: string;
  phases: CurvePhase[];
  min_c: number;
  max_c: number;
  is_default?: boolean;
}

export function curveToRow(c: TemperatureCurve, isDefault = false): CurveRow {
  return { id: c.id, name: c.name, phases: c.phases, min_c: c.minC, max_c: c.maxC, is_default: isDefault };
}

export function rowToCurve(r: CurveRow): TemperatureCurve {
  return { id: r.id, name: r.name, phases: r.phases, minC: r.min_c, maxC: r.max_c };
}

export interface NightRow {
  date: string;
  lights_out: string;
  wake: string;
  curve_id: string | null;
  tags: string[];
  ac_enabled: boolean;
  is_sim?: boolean;
}

/** 1-minute means (the stored resolution of health_hr). */
export function hrMinuteRows(personId: string, xs: HrSample[]) {
  const buckets = new Map<number, { sum: number; n: number; min: number }>();
  for (const h of xs) {
    if (!Number.isFinite(h.bpm)) continue;
    const k = Math.floor(h.ts / 60_000) * 60_000;
    const b = buckets.get(k);
    if (b) {
      b.sum += h.bpm;
      b.n++;
      b.min = Math.min(b.min, h.bpm);
    } else buckets.set(k, { sum: h.bpm, n: 1, min: h.bpm });
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([k, b]) => ({ person_id: personId, ts: iso(k), bpm: Math.round((b.sum / b.n) * 10) / 10, bpm_min: Math.round(b.min), n: Math.min(b.n, 32767) }));
}

export const rowToHr = (r: { ts: string; bpm: number }): HrSample => ({ ts: ms(r.ts), bpm: r.bpm });

export function hrvToRows(personId: string, xs: HrvSample[]) {
  return xs.map((h) => ({ person_id: personId, ts: iso(h.ts), rmssd_ms: h.rmssdMs }));
}
export const rowToHrv = (r: { ts: string; rmssd_ms: number }): HrvSample => ({ ts: ms(r.ts), rmssdMs: r.rmssd_ms });

export function spo2ToRows(personId: string, xs: Spo2Sample[]) {
  return xs.map((s) => ({ person_id: personId, ts: iso(s.ts), pct: s.pct }));
}
export const rowToSpo2 = (r: { ts: string; pct: number }): Spo2Sample => ({ ts: ms(r.ts), pct: r.pct });

export interface SleepRow {
  person_id: string;
  start_ts: string;
  end_ts: string;
  stages: StageSegment[];
  update_time: string | null;
  source: 'google' | 'sim' | 'own';
}

export function sleepToRow(s: SleepSession, source: SleepRow['source']): SleepRow {
  return {
    person_id: s.personId,
    start_ts: iso(s.start),
    end_ts: iso(s.end),
    stages: s.stages,
    update_time: s.updateTime === undefined ? null : iso(s.updateTime),
    source,
  };
}

export function rowToSleep(r: SleepRow): SleepSession {
  const s: SleepSession = { personId: r.person_id, start: ms(r.start_ts), end: ms(r.end_ts), stages: r.stages ?? [] };
  if (r.update_time) s.updateTime = ms(r.update_time);
  return s;
}
