import type { Ms, RoomReading } from '../types.ts';
import { plausibleCo2 } from '../switchbot/parse.ts';
import { MIN } from './util.ts';

/**
 * Room-data cleaning before a night is analysed. Real SwitchBot data has two failure modes:
 *
 *  - **Frozen values.** The cloud keeps answering GET /status with its last cached value (hub unplugged, or the
 *    meter's temperature/RH stuck after a restart while CO₂ still moves). A stretch of identical temperature + RH
 *    for more than `frozenMin` minutes is dropped when CO₂ moved by ≥ `co2ChangePpm` during it (the room clearly
 *    changed, so T/RH can't be real: kind `temp_rh`) or when CO₂ is identical too for more than `allFrozenMin` minutes
 *    with no webhook (device-pushed) row after its first (a cached snapshot: kind `all`).
 *    Identical T/RH with only CO₂ noise (an empty, stable room) is kept.
 *  - **Gaps.** No row for more than `gapMin` minutes (hub offline, poll skipped as stale).
 *
 * CO₂ < 300 ppm (the warm-up artifact) is counted, not dropped: every core metric already ignores it.
 */
export interface FrozenStretch {
  start: Ms;
  end: Ms;
  minutes: number;
  kind: 'temp_rh' | 'all';
  tempC: number;
  rh: number;
}

export interface DataGap {
  start: Ms;
  end: Ms;
  minutes: number;
}

export interface RoomDataQuality {
  /** Analysed window. */
  from: Ms;
  to: Ms;
  rawCount: number;
  keptCount: number;
  /** Rows with CO₂ < 300 ppm (kept for temp/RH, ignored for CO₂). */
  invalidCo2Count: number;
  frozen: FrozenStretch[];
  gaps: DataGap[];
  /** Minutes in the window (and in lights-out → wake) lost to frozen stretches / gaps. */
  frozenMinutes: number;
  frozenNightMinutes: number;
  gapMinutes: number;
  gapNightMinutes: number;
  /** Share of lights-out → wake minutes with a kept reading, 0..1, and the same in % (1 decimal). */
  coverage: number;
  coveragePct: number;
  /** frozen_temp_rh, frozen_all, gap_overnight, gap_morning, gap_evening, low_coverage, no_room_data, invalid_co2. */
  flags: string[];
}

export interface CleanOptions {
  from: Ms;
  to: Ms;
  lightsOut: Ms;
  wake: Ms;
  /** A frozen stretch must be longer than this (minutes). Default 30. */
  frozenMin?: number;
  /**
   * A stretch with identical temperature, RH AND CO₂ (a cached snapshot) must be longer than this (minutes) and have
   * no webhook row after its first row. Default 60.
   */
  allFrozenMin?: number;
  /** CO₂ range during identical T/RH that proves the room changed. Default 25 ppm. */
  co2ChangePpm?: number;
  /** A missing stretch longer than this is a gap (minutes). Default 5. */
  gapMin?: number;
  /** Below this lights-out → wake coverage the night gets `low_coverage`. Default 0.8. */
  lowCoverage?: number;
}

const overlapMin = (a0: Ms, a1: Ms, b0: Ms, b1: Ms) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)) / MIN;

export function cleanRoomReadings(readings: readonly RoomReading[], opts: CleanOptions): { readings: RoomReading[]; quality: RoomDataQuality } {
  const frozenMin = opts.frozenMin ?? 30;
  const co2Change = opts.co2ChangePpm ?? 25;
  const allFrozenMin = Math.max(frozenMin, opts.allFrozenMin ?? 60);
  const gapMin = opts.gapMin ?? 5;
  const { from, to, lightsOut, wake } = opts;

  // Sort, keep the window, one row per timestamp (the last one wins).
  const byTs = new Map<Ms, RoomReading>();
  for (const r of readings) if (Number.isFinite(r.ts) && r.ts >= from && r.ts < to) byTs.set(r.ts, r);
  const rs = [...byTs.values()].sort((a, b) => a.ts - b.ts);

  // Runs of identical temp + RH with no gap inside.
  const drop = new Set<number>();
  const frozen: FrozenStretch[] = [];
  let i = 0;
  while (i < rs.length) {
    let j = i;
    while (
      j + 1 < rs.length &&
      rs[j + 1]!.tempC === rs[i]!.tempC &&
      rs[j + 1]!.rh === rs[i]!.rh &&
      rs[j + 1]!.ts - rs[j]!.ts <= gapMin * MIN
    ) j++;
    const minutes = (rs[j]!.ts - rs[i]!.ts) / MIN + 1;
    if (minutes > frozenMin) {
      const co2 = rs.slice(i, j + 1).map((r) => r.co2).filter(plausibleCo2);
      const range = co2.length ? Math.max(...co2) - Math.min(...co2) : 0;
      // A cached snapshot (kind 'all') must also be long (> allFrozenMin) and carry no device-pushed row after its
      // first one: the meter only reports on change and the poll repeats the cache, so a still, real room makes
      // identical poll runs of 15–20 min, while a webhook repeating the same values proves the device was reporting.
      // (The run's first row is the change that started it, often a webhook, also before a freeze: 2026-10-30 09:08.)
      const pushed = rs.slice(i + 1, j + 1).some((r) => r.source === 'webhook');
      const kind: FrozenStretch['kind'] | null = range >= co2Change ? 'temp_rh' : range === 0 && minutes > allFrozenMin && !pushed ? 'all' : null;
      if (kind) {
        for (let k = i; k <= j; k++) drop.add(k);
        frozen.push({ start: rs[i]!.ts, end: rs[j]!.ts + MIN, minutes, kind, tempC: rs[i]!.tempC, rh: rs[i]!.rh });
      }
    }
    i = j + 1;
  }
  const kept = rs.filter((_, k) => !drop.has(k));

  // Gaps = no row at all (frozen stretches are reported separately, so nothing is counted twice).
  const gaps: DataGap[] = [];
  const pushGap = (a: Ms, b: Ms) => {
    const minutes = Math.round((b - a) / MIN);
    if (minutes > gapMin) gaps.push({ start: a, end: b, minutes });
  };
  let prevEnd = from;
  for (const r of rs) {
    pushGap(prevEnd, r.ts);
    prevEnd = r.ts + MIN;
  }
  pushGap(prevEnd, to);

  // Coverage: minutes of lights-out → wake with a kept reading.
  const nightMinutes = Math.max(1, Math.round((wake - lightsOut) / MIN));
  const covered = new Set<number>();
  for (const r of kept) if (r.ts >= lightsOut && r.ts < wake) covered.add(Math.floor((r.ts - lightsOut) / MIN));
  const coverage = Math.min(1, covered.size / nightMinutes);

  const sum = (xs: { start: Ms; end: Ms }[], a: Ms, b: Ms) => Math.round(xs.reduce((n, x) => n + overlapMin(x.start, x.end, a, b), 0));
  const invalidCo2Count = kept.filter((r) => !plausibleCo2(r.co2)).length;
  const flags: string[] = [];
  if (!kept.length) flags.push('no_room_data');
  if (frozen.some((f) => f.kind === 'temp_rh')) flags.push('frozen_temp_rh');
  if (frozen.some((f) => f.kind === 'all')) flags.push('frozen_all');
  if (sum(gaps, from, lightsOut) > 0) flags.push('gap_evening');
  if (sum(gaps, lightsOut, wake) > 0) flags.push('gap_overnight');
  if (sum(gaps, wake, to) > 0) flags.push('gap_morning');
  if (kept.length && coverage < (opts.lowCoverage ?? 0.8)) flags.push('low_coverage');
  if (invalidCo2Count) flags.push('invalid_co2');

  return {
    readings: kept,
    quality: {
      from,
      to,
      rawCount: rs.length,
      keptCount: kept.length,
      invalidCo2Count,
      frozen,
      gaps,
      frozenMinutes: sum(frozen, from, to),
      frozenNightMinutes: sum(frozen, lightsOut, wake),
      gapMinutes: sum(gaps, from, to),
      gapNightMinutes: sum(gaps, lightsOut, wake),
      coverage,
      coveragePct: Math.round(coverage * 1000) / 10,
      flags,
    },
  };
}
