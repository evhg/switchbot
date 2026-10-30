// Real-night helpers for the Today story (pure, no React): the room-only verdict, data-gap wording, room moments
// (settled, coolest, CO₂ levelling off) and the fresh-air estimate from the overnight CO₂ plateau. They make a night
// without watch data read as a complete story, and they say plainly where the data is missing or was left out.
import type { NightGap, RealNightInfo } from '@/lib/data/types.ts';
import { dur, fmt, hm, MIN } from '@/lib/format.ts';
import { quantile } from '@/lib/stats.ts';
import { plateauAch as corePlateauAch, type Night } from '@sleep-lab/core';
import { valueAt, type MinuteSeries } from './model.ts';

const deg = (v: number) => `${fmt(v, 1)}°`;

/** "No data 02:10–03:00", in words for a sentence (no trailing full stop). */
export function gapWords(g: NightGap): string {
  const span = `${hm(g.start)}–${hm(g.end)}`;
  if (g.kind === 'before-meter') return `the meter wasn’t connected until ${hm(g.end)}`;
  if (g.kind === 'frozen') return `${span} the cloud repeated a stale ${g.value ?? 'value'}, so those readings are left out`;
  return `no readings ${span} (${dur((g.end - g.start) / MIN)}): the hub was offline`;
}

/** Short label drawn inside a gap band on a chart. */
export const gapLabel = (g: NightGap) => (g.kind === 'before-meter' ? 'Not connected yet' : g.kind === 'frozen' ? 'Stale, left out' : 'No data');

const overlaps = (g: NightGap, a: number, b: number) => g.start < b && g.end > a;

/**
 * One calm sentence about data quality for the hero, or null when the night is fully covered. Mentions what is missing
 * inside lights out → wake, and a morning gap when it cost the fresh-air measurement.
 */
export function qualityNote(info: RealNightInfo | null | undefined, lo: number, wake: number, achMissing: boolean): string | null {
  if (!info) return null;
  const q = info.quality;
  const night = q.gaps.filter((g) => overlaps(g, lo, wake));
  const morning = q.gaps.filter((g) => !overlaps(g, lo, wake) && g.start >= wake && g.start < wake + 4 * 60 * MIN);
  const parts: string[] = [];
  if (night.length) {
    const pct = Math.round(q.coverage * 100);
    const what = night.map(gapWords);
    parts.push(`${pct}% of the night has readings: ${what.join('; ')}.`);
  }
  if (morning.length && achMissing) {
    const first = morning[0]!;
    parts.push(`The hub went quiet at ${hm(first.start)}, so the morning fresh-air measurement is missing.`);
  }
  if (q.co2Glitches > 0 && !parts.length) parts.push(`${q.co2Glitches} CO₂ reading${q.co2Glitches === 1 ? '' : 's'} of 0 ppm (the meter warming up) left out.`);
  return parts.length ? parts.join(' ') : null;
}

function finite(s: MinuteSeries, key: 'temp' | 'co2', a: number, b: number): number[] {
  const out: number[] = [];
  for (let t = a; t <= b; t += MIN) {
    const v = valueAt(s, key, t);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

/**
 * The room-only verdict (no watch data): "Cool and steady: 18.5–20.2° all night. CO₂ peaked at 940 ppm at 08:15."
 * The first clause is the two-tone head. Values come from the per-minute series (the same one the charts draw).
 */
export function roomVerdict(s: MinuteSeries, lo: number, wake: number, co2Peak: number, peakAt: number, crossAt: number | null): string {
  const temps = finite(s, 'temp', lo, wake);
  if (temps.length < 30) return 'Not enough room data last night: the meter covered too little of it to tell.';
  // "All night" means all night: the true lowest and highest clean readings, lights-out → wake. Steadiness is judged
  // on the 5th–95th percentile so one brief reading doesn't make a calm night "unsettled".
  const a = Math.min(...temps);
  const b = Math.max(...temps);
  const m = temps.reduce((x, y) => x + y, 0) / temps.length;
  const feel = m < 20.5 ? 'Cool' : m < 24 ? 'Mild' : 'Warm';
  const steady = quantile(temps, 0.95) - quantile(temps, 0.05) <= 1.3;
  const range = Math.abs(b - a) < 0.15 ? `${deg(m)} all night` : `${fmt(a, 1)}–${deg(b)} all night`;
  const head = `${feel} and ${steady ? 'steady' : 'unsettled'}: ${range}.`;
  const co2 = !Number.isFinite(co2Peak)
    ? ''
    : crossAt !== null
      ? ` CO₂ crossed 1,000 ppm at ${hm(crossAt)} and peaked at ${fmt(Math.round(co2Peak))}.`
      : ` CO₂ peaked at ${fmt(Math.round(co2Peak))} ppm${co2Peak < 800 ? ', fresh all night' : ` at ${hm(peakAt)}`}.`;
  return `${head}${co2}`;
}

/** The night's overnight fresh-air estimate (core plateauAch, the same figure the backend stores in night_metrics). */
export interface NightPlateau {
  ach: number;
  /** CO₂ at the end of the night (median of the last 15 min before wake). */
  ppm: number;
  /** Start of the window it was read from (wake − 90 min). */
  from: number;
  /** 'plateau' = CO₂ had levelled off; 'upper_bound' = still rising at wake, so the true figure is lower. */
  kind: 'plateau' | 'upper_bound';
}

/**
 * Fresh air from where CO₂ ended the night: ACH = G·3600 / V / (C − outdoor) with two sleepers, from the last 90 min
 * before wake. Shared with the backend (core plateauAch on the same cleaned readings), so both say the same number.
 */
export function nightPlateau(night: Night): NightPlateau | null {
  const p = corePlateauAch(night.room, night.wake);
  return p ? { ach: p.ach, ppm: p.ppm, from: p.from, kind: p.kind } : null;
}

/** When the room settled: first minute after which it stays within ±0.3 °C of the second-half median for an hour. */
export function settledAt(s: MinuteSeries, lo: number, wake: number): { t: number; v: number } | null {
  const half = finite(s, 'temp', lo + (wake - lo) / 2, wake);
  if (half.length < 60) return null;
  const med = quantile(half, 0.5);
  for (let t = lo; t + 60 * MIN <= wake; t += 5 * MIN) {
    let ok = true;
    let n = 0;
    for (let k = 0; k <= 60 && ok; k += 5) {
      const v = valueAt(s, 'temp', t + k * MIN);
      if (!Number.isFinite(v)) continue;
      n++;
      ok = Math.abs(v - med) <= 0.3;
    }
    if (ok && n >= 8) return { t, v: med };
  }
  return null;
}

export function coolestAt(s: MinuteSeries, lo: number, wake: number): { t: number; v: number } | null {
  let best: { t: number; v: number } | null = null;
  for (let t = lo; t <= wake; t += MIN) {
    const v = valueAt(s, 'temp', t);
    if (Number.isFinite(v) && (!best || v < best.v - 0.04)) best = { t, v };
  }
  return best;
}

/** The overnight estimate's ACH: the fallback when there is no morning decay. */
export function nightPlateauAch(night: Night): number | null {
  return nightPlateau(night)?.ach ?? null;
}
