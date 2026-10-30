// Night analysis: load the room readings of one night (lights-out − 2 h → max(12:00, wake + 2 h)), clean them (core
// cleanRoomReadings: frozen temp/RH, cached snapshots, gaps; CO2 < 300 ignored), detect events, compute room metrics
// and the morning CO2 decay after both left, and store events (source 'detector') + public.night_metrics
// (migration 0016). Idempotent: a re-run replaces the night's detector events and upserts the metrics row.
// Used by night-analysis (on demand / backfill) and nightly-report (before every report).
import { fitDecayAch, plateauAch } from '../../../packages/core/src/metrics/co2.ts';
import { detectEvents } from '../../../packages/core/src/metrics/events.ts';
import { type RoomDataQuality, cleanRoomReadings } from '../../../packages/core/src/metrics/quality.ts';
import { roomNightMetrics } from '../../../packages/core/src/metrics/room.ts';
import type { Ms, Night, RoomEvent, RoomNightMetrics, TemperatureCurve } from '../../../packages/core/src/types.ts';
import { loadCurve, loadNight, loadRoom } from './load.ts';
import { eventToRow, type NightRow } from './rows.ts';
import { type Db, must } from './supabase.ts';
import { HOUR, ictAt, iso } from './time.ts';

export const ANALYSIS_VERSION = 2;

export interface DecayFit {
  ach: number;
  r2: number;
  baseline: number;
  start: Ms;
  end: Ms;
  from: 'room_empty' | 'wake';
}

export interface NightAnalysis {
  row: NightRow;
  curve: TemperatureCurve;
  /** The night with CLEANED room readings and freshly detected events. */
  night: Night;
  quality: RoomDataQuality;
  metrics: RoomNightMetrics;
  decay: DecayFit | null;
  flags: string[];
  liveAcCommands: number;
}

/** The analysed window of a night. */
export function analysisWindow(row: Pick<NightRow, 'date' | 'lights_out' | 'wake'>): { from: Ms; to: Ms } {
  const lightsOut = Date.parse(row.lights_out);
  const wake = Date.parse(row.wake);
  return { from: lightsOut - 2 * HOUR, to: Math.max(ictAt(row.date, '12:00'), wake + 2 * HOUR) };
}

const hhmm = (ms: Ms) => new Date(ms + 7 * HOUR).toISOString().slice(11, 16);
const num = (x: number | null | undefined) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const int = (x: number | null | undefined) => (num(x) === null ? null : Math.round(x!));

/**
 * Morning decay "after both left": from the start of a detected room_empty that begins after wake − 60 min (the
 * detector's departure), else from wake, up to the end of the window.
 */
export function morningDecay(room: Night['room'], events: RoomEvent[], wake: Ms, to: Ms): DecayFit | null {
  const empty = events.find((e) => e.kind === 'room_empty' && e.start >= wake - HOUR && e.start < to);
  const tries: [Ms, DecayFit['from']][] = empty ? [[empty.start, 'room_empty'], [wake, 'wake']] : [[wake, 'wake']];
  for (const [from, kind] of tries) {
    const fit = fitDecayAch(room.filter((r) => r.ts >= from && r.ts <= to));
    if (fit) return { ach: fit.ach, r2: fit.r2, baseline: fit.baseline, start: fit.start, end: fit.end, from: kind };
  }
  return null;
}

export async function analyzeNight(
  db: Db,
  row: NightRow,
  opts: { deviceId: string; personIds: string[]; curve?: TemperatureCurve; store?: boolean },
): Promise<NightAnalysis> {
  const lightsOut = Date.parse(row.lights_out);
  const wake = Date.parse(row.wake);
  const { from, to } = analysisWindow(row);
  const [raw, curve, liveAc] = await Promise.all([
    loadRoom(db, opts.deviceId, from, to),
    opts.curve ? Promise.resolve(opts.curve) : loadCurve(db, row.curve_id),
    db.from('ac_commands').select('id', { count: 'exact', head: true }).eq('night_date', row.date).eq('dry_run', false).or('sent_ok.is.null,sent_ok.eq.true'),
  ]);
  if (liveAc.error) throw new Error(`ac_commands: ${liveAc.error.message}`);
  const { readings, quality } = cleanRoomReadings(raw, { from, to, lightsOut, wake });
  const night = await loadNight(db, row, { deviceId: opts.deviceId, personIds: opts.personIds, room: readings });
  const liveAcCommands = liveAc.count ?? 0;
  // A night without a live aircon command ran by hand: scored against the comfort target, not its stored plan.
  night.manual = liveAcCommands === 0;
  // The occupancy detector uses the night's ventilation estimate (end-of-night CO₂ plateau) in its mass balance.
  const plateau = plateauAch(night.room, wake);
  night.events = detectEvents(night.room, { lightsOut, wake, ach: plateau?.ach ?? null });
  const metrics = roomNightMetrics(night, curve);
  const decay = morningDecay(night.room, night.events, wake, to);

  const flags = [...quality.flags];
  if (!decay) flags.push('no_morning_decay');
  if (liveAcCommands === 0) flags.push('manual_night');
  if (!night.people.length) flags.push('no_health_data');

  const analysis: NightAnalysis = { row, curve, night, quality, metrics, decay, flags, liveAcCommands };
  if (opts.store !== false) await storeAnalysis(db, analysis);
  return analysis;
}

async function storeAnalysis(db: Db, a: NightAnalysis): Promise<void> {
  const date = a.row.date;
  const del = await db.from('events').delete().eq('night_date', date).eq('source', 'detector');
  if (del.error) throw new Error(`events delete: ${del.error.message}`);
  if (a.night.events.length) {
    const ins = await db.from('events').insert(a.night.events.map((e) => eventToRow(date, e, 'detector')));
    if (ins.error) throw new Error(`events insert: ${ins.error.message}`);
  }
  const m = a.metrics;
  const q = a.quality;
  const row = {
    date,
    computed_at: new Date().toISOString(),
    analysis_version: ANALYSIS_VERSION,
    curve_id: a.curve.id,
    lights_out: a.row.lights_out,
    wake: a.row.wake,
    window_from: iso(q.from),
    window_to: iso(q.to),
    sleep_air_score: int(m.sleepAirScore),
    co2_mean: int(m.co2Mean),
    co2_p95: int(m.co2P95),
    co2_max: int(m.co2Max),
    minutes_co2_over_1000: int(m.minutesCo2Over1000),
    minutes_co2_over_1500: int(m.minutesCo2Over1500),
    temp_mean: num(m.tempMean),
    temp_early_mean: num(m.tempEarlyMean),
    minutes_temp_in_target: int(m.minutesTempInTarget),
    minutes_temp_over_24: int(m.minutesTempOver24),
    rh_mean: num(m.rhMean),
    minutes_rh_over_60: int(m.minutesRhOver60),
    minutes_rh_in_band: int(m.minutesRhInBand),
    ach_morning: a.decay ? Math.round(a.decay.ach * 1000) / 1000 : null,
    ach_r2: a.decay ? Math.round(a.decay.r2 * 1000) / 1000 : null,
    ach_baseline_ppm: a.decay ? Math.round(a.decay.baseline) : null,
    decay_start: a.decay ? iso(a.decay.start) : null,
    decay_end: a.decay ? iso(a.decay.end) : null,
    decay_from: a.decay?.from ?? null,
    ach_plateau: m.achPlateau ?? null,
    ach_plateau_kind: m.achPlateauKind ?? null,
    ach_plateau_ppm: m.achPlateauPpm ?? null,
    coverage_pct: q.coveragePct,
    frozen_minutes: q.frozenMinutes,
    frozen_night_minutes: q.frozenNightMinutes,
    gap_minutes: q.gapMinutes,
    gap_night_minutes: q.gapNightMinutes,
    invalid_co2_count: q.invalidCo2Count,
    flags: a.flags,
    quality: qualityJson(q),
    room: JSON.parse(JSON.stringify(m, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v))),
    events_count: a.night.events.length,
    ac_commands: a.night.ac.length,
    live_ac_commands: a.liveAcCommands,
    people_count: a.night.people.length,
  };
  const up = await db.from('night_metrics').upsert(row, { onConflict: 'date' });
  if (up.error) throw new Error(`night_metrics: ${up.error.message}`);
}

/** RoomDataQuality with ISO times (for jsonb). */
export function qualityJson(q: RoomDataQuality) {
  return {
    ...q,
    from: iso(q.from),
    to: iso(q.to),
    frozen: q.frozen.map((f) => ({ ...f, start: iso(f.start), end: iso(f.end) })),
    gaps: q.gaps.map((g) => ({ ...g, start: iso(g.start), end: iso(g.end) })),
  };
}

/** Compact, ICT-clock data-quality facts for the report and the coach prompt. */
export function dataQualityFacts(a: Pick<NightAnalysis, 'quality' | 'flags' | 'decay'> & { metrics?: Pick<RoomNightMetrics, 'achPlateau' | 'achPlateauKind' | 'achPlateauPpm'> }) {
  const q = a.quality;
  return {
    coveragePct: q.coveragePct,
    frozenNightMinutes: q.frozenNightMinutes,
    gapNightMinutes: q.gapNightMinutes,
    frozen: q.frozen.map((f) => ({ from: hhmm(f.start), to: hhmm(f.end), minutes: f.minutes, kind: f.kind })),
    gaps: q.gaps.map((g) => ({ from: hhmm(g.start), to: hhmm(g.end), minutes: g.minutes })),
    morningDecay: a.decay ? { ach: Math.round(a.decay.ach * 100) / 100, from: hhmm(a.decay.start), to: hhmm(a.decay.end) } : null,
    overnightAch: a.metrics?.achPlateau != null ? { ach: a.metrics.achPlateau, kind: a.metrics.achPlateauKind ?? null, endPpm: a.metrics.achPlateauPpm ?? null } : null,
    manualNight: a.flags.includes('manual_night'),
    flags: a.flags,
  };
}

/**
 * One plain sentence about data problems that change how the night should be read, or null when the data is clean.
 * Only numbers from the analysis appear in it, so the coach's grounding check accepts them.
 */
export function qualityCaveat(a: Pick<NightAnalysis, 'quality' | 'flags' | 'decay' | 'row'> & { metrics?: Pick<RoomNightMetrics, 'achPlateau'> }): string | null {
  const q = a.quality;
  const lightsOut = Date.parse(a.row.lights_out);
  const wake = Date.parse(a.row.wake);
  const parts: string[] = [];
  const nightFrozen = q.frozen.filter((f) => f.end > lightsOut && f.start < wake);
  for (const f of nightFrozen) {
    parts.push(`${f.kind === 'temp_rh' ? 'temperature and humidity were frozen' : 'the meter repeated a cached value'} ${hhmm(f.start)}–${hhmm(f.end)} and were left out`);
  }
  const nightGaps = q.gaps.filter((g) => g.end > lightsOut && g.start < wake);
  if (nightGaps.length) parts.push(`${q.gapNightMinutes} min of the night had no readings`);
  if (!a.decay) {
    const morning = [...q.frozen, ...q.gaps].filter((x) => x.end > wake && x.start < q.to).sort((x, y) => x.start - y.start)[0];
    const fallback = a.metrics?.achPlateau != null ? ', so ventilation is estimated from the overnight CO₂ level' : '';
    parts.push(morning ? `no morning CO₂ decay (meter offline or frozen from ${hhmm(morning.start)})${fallback}` : `no clean morning CO₂ decay${fallback}`);
  }
  if (!parts.length) return null;
  return `Data note: ${parts.join('; ')}. Clean readings cover ${q.coveragePct}% of lights-out → wake.`;
}

/** Wake date of the night that ended most recently at `now` (its wake time has passed). */
export async function lastEndedNightDate(db: Db, now: Ms, today: string, yesterday: string): Promise<string> {
  const row = must(await db.from('nights').select('wake').eq('date', today).maybeSingle(), 'nights') as { wake: string } | null;
  const wake = row ? Date.parse(row.wake) : ictAt(today, '08:30');
  return now >= wake ? today : yesterday;
}
