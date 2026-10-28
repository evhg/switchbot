// Google Health API v4 list/reconcile responses → core types. See docs/research/health-data.md §2.5.
// Field names follow the documented camelCase JSON; snake_case variants are accepted too.
import type { HrSample, HrvSample, Ms, SleepSession, SleepStage, Spo2Sample, StageSegment } from '../types.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const snakeKey = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** o[key] or o[snake_key]. */
function field(o: unknown, key: string): unknown {
  if (!isObj(o)) return undefined;
  return key in o ? o[key] : o[snakeKey(key)];
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** RFC 3339 string, epoch ms, or {seconds, nanos}. */
export function parseGoogleTime(v: unknown): Ms | null {
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (isObj(v)) {
    const s = num(v.seconds);
    if (s !== null) return s * 1000 + Math.floor((num(v.nanos) ?? 0) / 1e6);
  }
  return null;
}

/**
 * Flattens what callers typically hold: a page `{dataPoints}`, an array of pages,
 * or an array of data points.
 */
export function dataPointsOf(json: unknown): Obj[] {
  if (Array.isArray(json)) return json.flatMap((x) => (isObj(x) && (field(x, 'dataPoints') !== undefined) ? dataPointsOf(x) : isObj(x) ? [x] : []));
  const dp = field(json, 'dataPoints');
  return Array.isArray(dp) ? dp.filter(isObj) : [];
}

function sampleTime(rec: unknown): Ms | null {
  return parseGoogleTime(field(field(rec, 'sampleTime'), 'physicalTime'));
}

/** Sorted ascending (the API returns newest first), one value per timestamp. */
function sortDedupe<T extends { ts: Ms }>(xs: T[]): T[] {
  xs.sort((a, b) => a.ts - b.ts);
  return xs.filter((x, i) => i === 0 || x.ts !== xs[i - 1]!.ts);
}

/** heart-rate: heartRate.sampleTime.physicalTime, heartRate.beatsPerMinute (int64 as string). */
export function parseHeartRate(json: unknown): HrSample[] {
  const out: HrSample[] = [];
  for (const p of dataPointsOf(json)) {
    const r = field(p, 'heartRate');
    const ts = sampleTime(r);
    const bpm = num(field(r, 'beatsPerMinute'));
    if (ts !== null && bpm !== null && bpm >= 1 && bpm <= 300) out.push({ ts, bpm });
  }
  return sortDedupe(out);
}

/** heart-rate-variability: rootMeanSquareOfSuccessiveDifferencesMilliseconds (optional per sample; documented range 1..200). */
export function parseHrv(json: unknown): HrvSample[] {
  const out: HrvSample[] = [];
  for (const p of dataPointsOf(json)) {
    const r = field(p, 'heartRateVariability');
    const ts = sampleTime(r);
    const rmssd = num(field(r, 'rootMeanSquareOfSuccessiveDifferencesMilliseconds'));
    if (ts !== null && rmssd !== null && rmssd > 0) out.push({ ts, rmssdMs: rmssd });
  }
  return sortDedupe(out);
}

/** oxygen-saturation: oxygenSaturation.percentage (0..100). */
export function parseSpo2(json: unknown): Spo2Sample[] {
  const out: Spo2Sample[] = [];
  for (const p of dataPointsOf(json)) {
    const r = field(p, 'oxygenSaturation');
    const ts = sampleTime(r);
    const pct = num(field(r, 'percentage'));
    if (ts !== null && pct !== null && pct > 0 && pct <= 100) out.push({ ts, pct });
  }
  return sortDedupe(out);
}

/**
 * STAGES sleep uses AWAKE/LIGHT/DEEP/REM. CLASSIC sleep (no staging) uses ASLEEP/RESTLESS/AWAKE;
 * we map ASLEEP → light and RESTLESS → awake as an approximation. Enum prefixes are tolerated.
 */
export function mapSleepStage(type: unknown): SleepStage | null {
  if (typeof type !== 'string') return null;
  const t = type.toUpperCase();
  if (t.endsWith('AWAKE') || t.endsWith('WAKE') || t.endsWith('RESTLESS')) return 'awake';
  if (t.endsWith('DEEP')) return 'deep';
  if (t.endsWith('REM')) return 'rem';
  if (t.endsWith('LIGHT') || t.endsWith('ASLEEP')) return 'light';
  return null;
}

export interface ParseSleepOptions {
  /** Default true. */
  includeNaps?: boolean;
}

/** sleep: interval{startTime,endTime}, stages[{startTime,endTime,type}], metadata.nap, updateTime. */
export function parseSleep(json: unknown, personId: string, opts: ParseSleepOptions = {}): SleepSession[] {
  const byStart = new Map<Ms, SleepSession>();
  for (const p of dataPointsOf(json)) {
    const s = field(p, 'sleep');
    if (!isObj(s)) continue;
    if (opts.includeNaps === false && field(field(s, 'metadata'), 'nap') === true) continue;
    const interval = field(s, 'interval');
    const start = parseGoogleTime(field(interval, 'startTime'));
    const end = parseGoogleTime(field(interval, 'endTime'));
    if (start === null || end === null || end <= start) continue;
    const stages: StageSegment[] = [];
    const raw = field(s, 'stages');
    for (const st of Array.isArray(raw) ? raw : []) {
      const a = parseGoogleTime(field(st, 'startTime'));
      const b = parseGoogleTime(field(st, 'endTime'));
      const stage = mapSleepStage(field(st, 'type'));
      if (a !== null && b !== null && b > a && stage) stages.push({ start: a, end: b, stage });
    }
    stages.sort((x, y) => x.start - y.start);
    const session: SleepSession = { personId, start, end, stages };
    const upd = parseGoogleTime(field(s, 'updateTime') ?? field(p, 'updateTime'));
    if (upd !== null) session.updateTime = upd;
    // The same night can appear twice across pages/reprocessing; keep the newest version.
    const prev = byStart.get(start);
    if (!prev || (session.updateTime ?? 0) >= (prev.updateTime ?? 0)) byStart.set(start, session);
  }
  return [...byStart.values()].sort((a, b) => a.start - b.start);
}

// ---------- Daily values: steps, resting HR, daily HRV ----------

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Google `Date` ({year, month, day}) or "YYYY-MM-DD…" → "YYYY-MM-DD". */
export function parseCivilDate(v: unknown): string | null {
  if (typeof v === 'string') return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
  const y = num(field(v, 'year'));
  const m = num(field(v, 'month'));
  const d = num(field(v, 'day'));
  if (y === null || m === null || d === null || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** Local calendar date of an instant at a fixed UTC offset (minutes; ICT = +420, no DST). */
export function localDate(ts: Ms, utcOffsetMin = 420): string {
  return new Date(ts + utcOffsetMin * 60_000).toISOString().slice(0, 10);
}

export interface StepInterval {
  start: Ms;
  end: Ms;
  count: number;
}

/** steps: steps.interval{startTime, endTime}, steps.count (int64 as string). One value per interval start (pages can overlap). */
export function parseStepIntervals(json: unknown): StepInterval[] {
  const out: (StepInterval & { ts: Ms })[] = [];
  for (const p of dataPointsOf(json)) {
    const r = field(p, 'steps');
    const interval = field(r, 'interval');
    const start = parseGoogleTime(field(interval, 'startTime'));
    const end = parseGoogleTime(field(interval, 'endTime'));
    const count = num(field(r, 'count'));
    if (start === null || end === null || end < start || count === null || count < 0) continue;
    out.push({ ts: start, start, end, count });
  }
  return sortDedupe(out).map(({ start, end, count }) => ({ start, end, count }));
}

export interface DailySteps {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  steps: number;
}

/**
 * Daily step totals from interval data (1-min intervals in v4), bucketed by the local date of each interval's
 * start. Thailand has no DST, so a fixed +7 h offset is exact. Oldest first. A day at the edge of the fetched
 * window is partial; callers should fetch from local midnight.
 */
export function dailyStepTotals(json: unknown, utcOffsetMin = 420): DailySteps[] {
  const byDate = new Map<string, number>();
  for (const s of parseStepIntervals(json)) {
    const d = localDate(s.start, utcOffsetMin);
    byDate.set(d, (byDate.get(d) ?? 0) + s.count);
  }
  return [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, steps]) => ({ date, steps: Math.round(steps) }));
}

/** Latest version per civil date (Google recomputes daily values; updateTime decides). */
function latestPerDate<T extends { date: string }>(json: unknown, key: string, read: (r: unknown, date: string) => T | null): T[] {
  const best = new Map<string, { v: T; upd: number }>();
  for (const p of dataPointsOf(json)) {
    const r = field(p, key);
    const date = parseCivilDate(field(r, 'date'));
    if (!date) continue;
    const v = read(r, date);
    if (!v) continue;
    const upd = parseGoogleTime(field(p, 'updateTime') ?? field(r, 'updateTime')) ?? 0;
    const prev = best.get(date);
    if (!prev || upd >= prev.upd) best.set(date, { v, upd });
  }
  return [...best.values()].map((b) => b.v).sort((a, b) => (a.date < b.date ? -1 : 1));
}

export interface DailyRestingHr {
  date: string;
  bpm: number;
  /** WITH_SLEEP or ONLY_WITH_AWAKE_DATA. */
  method?: string;
}

/** daily-resting-heart-rate: dailyRestingHeartRate{date, beatsPerMinute, dailyRestingHeartRateMetadata{calculationMethod}}. */
export function parseDailyRestingHr(json: unknown): DailyRestingHr[] {
  return latestPerDate(json, 'dailyRestingHeartRate', (r, date) => {
    const bpm = num(field(r, 'beatsPerMinute'));
    if (bpm === null || bpm < 20 || bpm > 200) return null;
    const out: DailyRestingHr = { date, bpm };
    const method = field(field(r, 'dailyRestingHeartRateMetadata'), 'calculationMethod');
    if (typeof method === 'string') out.method = method;
    return out;
  });
}

export interface DailyHrv {
  date: string;
  /** averageHeartRateVariabilityMilliseconds (nightly RMSSD). */
  averageMs?: number;
  /** deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds. */
  deepSleepRmssdMs?: number;
  /** nonRemHeartRateBeatsPerMinute. */
  nonRemHr?: number;
}

/** daily-heart-rate-variability: dailyHeartRateVariability{date, averageHeartRateVariabilityMilliseconds, deepSleepRoot…Milliseconds, nonRemHeartRateBeatsPerMinute, entropy}. */
export function parseDailyHrv(json: unknown): DailyHrv[] {
  return latestPerDate(json, 'dailyHeartRateVariability', (r, date) => {
    const out: DailyHrv = { date };
    const avg = num(field(r, 'averageHeartRateVariabilityMilliseconds'));
    const deep = num(field(r, 'deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds'));
    const nrem = num(field(r, 'nonRemHeartRateBeatsPerMinute'));
    if (avg !== null && avg > 0) out.averageMs = avg;
    if (deep !== null && deep > 0) out.deepSleepRmssdMs = deep;
    if (nrem !== null && nrem > 0) out.nonRemHr = nrem;
    return out.averageMs === undefined && out.deepSleepRmssdMs === undefined && out.nonRemHr === undefined ? null : out;
  });
}
