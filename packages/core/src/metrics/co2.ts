import type { Ms, RoomReading } from '../types.ts';
import { plausibleCo2 } from '../switchbot/parse.ts';
import { HOUR, MIN, goldenMin, median, rollingMedian, sortByTs } from './util.ts';

export const DEFAULT_OUTDOOR_CO2 = 425;
export const DEFAULT_VOLUME_M3 = 120;
/** Fallback overnight parameters (docs/research/sleep-science.md §4): sealed room, two sleepers. */
export const FALLBACK_ACH = 0.2;
export const FALLBACK_GEN_LPS = 0.0062;

/** ppm/h added to a room of `volumeM3` by `lps` litres/s of CO₂. */
export const lpsToPpmPerHour = (lps: number, volumeM3: number) => (lps * 3.6e6) / volumeM3;

interface Series { t: number[]; y: number[] }

function series(readings: readonly RoomReading[]): Series & { ts: Ms[] } {
  const rs = sortByTs(readings).filter((r) => plausibleCo2(r.co2) && Number.isFinite(r.ts));
  const t0 = rs[0]?.ts ?? 0;
  return { ts: rs.map((r) => r.ts), t: rs.map((r) => (r.ts - t0) / HOUR), y: rs.map((r) => r.co2) };
}

function sst(y: readonly number[]): number {
  const m = y.reduce((a, b) => a + b, 0) / y.length;
  return y.reduce((a, v) => a + (v - m) ** 2, 0);
}

/** Exponential decay to baseline cb with amplitude solved in closed form. */
function decaySse(s: Series, cb: number, k: number): number {
  let num = 0, den = 0;
  for (let i = 0; i < s.t.length; i++) {
    const e = Math.exp(-k * s.t[i]!);
    num += (s.y[i]! - cb) * e;
    den += e * e;
  }
  const a = den ? num / den : 0;
  let sse = 0;
  for (let i = 0; i < s.t.length; i++) sse += (s.y[i]! - cb - a * Math.exp(-k * s.t[i]!)) ** 2;
  return sse;
}

function bestK(s: Series, cb: number): { k: number; sse: number } {
  const lk = goldenMin((x) => decaySse(s, cb, Math.exp(x)), Math.log(0.02), Math.log(10), 50);
  const k = Math.exp(lk);
  return { k, sse: decaySse(s, cb, k) };
}

function fitDecayWindow(s: Series, outdoor: number) {
  const minY = Math.min(...s.y);
  const cbMax = Math.min(600, minY - 5);
  const fixedCb = Math.min(outdoor, minY - 10);
  const fixed = { cb: fixedCb, ...bestK(s, fixedCb) };
  let free = fixed;
  if (cbMax >= 380) {
    for (let cb = 380; cb <= cbMax; cb += 5) {
      const f = bestK(s, cb);
      if (f.sse < free.sse) free = { cb, ...f };
    }
    for (let cb = Math.max(380, free.cb - 4); cb <= Math.min(cbMax, free.cb + 4); cb++) {
      const f = bestK(s, cb);
      if (f.sse < free.sse) free = { cb, ...f };
    }
  }
  // Only trust a fitted baseline when it clearly beats the assumed one and the window spans ≥ 1 time constant.
  const T = s.t[s.t.length - 1]!;
  const useFree = free !== fixed && free.sse < 0.7 * fixed.sse && free.k * T >= 1;
  const best = useFree ? free : fixed;
  const tot = sst(s.y);
  return { ach: best.k, baseline: best.cb, r2: tot > 0 ? 1 - best.sse / tot : 0 };
}

/**
 * Air changes per hour from the cleanest CO₂ decay (tracer-gas method, OpenEnergyMonitor):
 * C(t) = Cb + (C0 − Cb)·e^(−ACH·t). Candidate windows are near-monotone declines of ≥ minMinutes
 * and ≥ 150 ppm; fits with r² < 0.9 are rejected.
 */
export function fitDecayAch(
  readings: RoomReading[],
  opts: { outdoorCo2?: number; minMinutes?: number } = {},
): { ach: number; r2: number; start: Ms; end: Ms; baseline: number } | null {
  const outdoor = opts.outdoorCo2 ?? DEFAULT_OUTDOOR_CO2;
  const minMin = opts.minMinutes ?? 60;
  const all = series(readings);
  const n = all.y.length;
  if (n < 10) return null;
  const sm = rollingMedian(all.y, 2);
  const tol = 25;
  const maxGap = 15 * MIN;
  const windows: [number, number][] = [];
  let i = 0;
  while (i < n - 1) {
    let start = i;
    let minIdx = i;
    let j = i + 1;
    while (j < n && all.ts[j]! - all.ts[j - 1]! <= maxGap) {
      if (sm[j]! > sm[start]! && minIdx === start) { start = j; minIdx = j; j++; continue; }
      if (sm[j]! > sm[minIdx]! + tol) break;
      if (sm[j]! < sm[minIdx]!) minIdx = j;
      j++;
    }
    if (minIdx > start) {
      windows.push([start, minIdx]);
      i = minIdx;
    } else i = Math.max(j, i + 1);
  }
  let best: { ach: number; r2: number; start: Ms; end: Ms; baseline: number; score: number } | null = null;
  for (const [s0, e] of windows) {
    // Trim a leading plateau: the decay starts at the last point still near the peak.
    const amp0 = sm[s0]! - sm[e]!;
    let s = s0;
    for (let k = s0; k <= e; k++) if (sm[k]! >= sm[s0]! - Math.max(15, 0.02 * amp0)) s = k;
    // Skip an early door-like plunge (much faster than the window's typical decay) so it doesn't inflate ACH.
    const d5: number[] = [];
    for (let k = s; k + 5 <= e; k++) d5.push(sm[k]! - sm[k + 5]!);
    const typical = median(d5);
    for (let k = s; k + 5 <= e && k < s + (e - s) / 3; k++) {
      if (sm[k]! - sm[k + 5]! > Math.max(40, 4 * typical)) s = k + 5;
    }
    const fitFrom = (a: number) => {
      const t0 = all.ts[a]!;
      return fitDecayWindow({ t: all.ts.slice(a, e + 1).map((x) => (x - t0) / HOUR), y: all.y.slice(a, e + 1) }, outdoor);
    };
    const minSpan = (a: number) => all.ts[e]! - all.ts[a]! >= minMin * MIN && sm[a]! - sm[e]! >= 150;
    if (!minSpan(s)) continue;
    let fit = fitFrom(s);
    // A long door opening early in the window makes the whole-window ACH faster than its tail's.
    // Trim in 15-min steps until the fit agrees with the second half.
    const mid = all.ts.findIndex((x, k) => k > s && x >= (all.ts[s]! + all.ts[e]!) / 2);
    if (mid > 0 && e - mid >= 20) {
      const late = fitFrom(mid);
      if (late.r2 >= 0.8 && fit.ach > 1.3 * late.ach) {
        let s2 = s;
        let fixed = false;
        while (true) {
          const next = all.ts.findIndex((x, k) => k > s2 && x >= all.ts[s2]! + 15 * MIN);
          if (next < 0 || !minSpan(next)) break;
          s2 = next;
          const f2 = fitFrom(s2);
          if (f2.ach <= 1.3 * late.ach) { fit = f2; s = s2; fixed = true; break; }
        }
        if (!fixed) continue;
      }
    }
    const t0 = all.ts[s]!;
    const amp = sm[s]! - sm[e]!;
    const durMin = (all.ts[e]! - t0) / MIN;
    if (fit.r2 < 0.9) continue;
    const score = fit.r2 * Math.log(amp * durMin);
    if (!best || score > best.score) best = { ...fit, start: t0, end: all.ts[e]!, score };
  }
  if (!best) return null;
  const { score: _s, ...out } = best;
  return out;
}

/** Linear LS of y' = a·f1 + b·f2 for the mass-balance rise with fixed k (h⁻¹). */
function buildupAt(s: Series, cout: number, k: number) {
  let s11 = 0, s12 = 0, s22 = 0, s1y = 0, s2y = 0;
  const f = s.t.map((t) => {
    const e = Math.exp(-k * t);
    return [k > 1e-9 ? (1 - e) / k : t, e] as const;
  });
  for (let i = 0; i < f.length; i++) {
    const [f1, f2] = f[i]!;
    const y = s.y[i]! - cout;
    s11 += f1 * f1; s12 += f1 * f2; s22 += f2 * f2; s1y += f1 * y; s2y += f2 * y;
  }
  const det = s11 * s22 - s12 * s12;
  let a = det ? (s1y * s22 - s2y * s12) / det : 0;
  let b = det ? (s2y * s11 - s1y * s12) / det : s2y / (s22 || 1);
  if (a < 0) { a = 0; b = s2y / (s22 || 1); }
  let sse = 0;
  for (let i = 0; i < f.length; i++) sse += (s.y[i]! - cout - a * f[i]![0] - b * f[i]![1]) ** 2;
  return { a, b, sse };
}

/**
 * Generation rate and ACH from an overnight rise, using the mass balance
 * dC/dt = G·3.6e6/V − ACH·(C − Cout), fitted by least squares on its analytic solution.
 * Pass `ach` to fix ventilation and fit G only.
 */
export function fitBuildup(
  readings: RoomReading[],
  opts: { outdoorCo2?: number; volumeM3?: number; ach?: number } = {},
): { generationLps: number; ach: number; r2: number } | null {
  const cout = opts.outdoorCo2 ?? DEFAULT_OUTDOOR_CO2;
  const vol = opts.volumeM3 ?? DEFAULT_VOLUME_M3;
  const s = series(readings);
  if (s.y.length < 20 || s.t[s.t.length - 1]! < 0.5) return null;
  const k = opts.ach ?? Math.exp(goldenMin((x) => buildupAt(s, cout, Math.exp(x)).sse, Math.log(0.01), Math.log(3), 50));
  const fit = buildupAt(s, cout, k);
  const tot = sst(s.y);
  return { generationLps: (fit.a * vol) / 3.6e6, ach: k, r2: tot > 0 ? 1 - fit.sse / tot : 0 };
}

/**
 * Project CO₂ from the latest reading to untilTs (5-min steps). Parameters come from a buildup fit on
 * the last 4 h; implausible fits fall back to ACH 0.2 (refitting G) and then to 0.0062 L/s.
 */
export function forecastCo2(
  readings: RoomReading[],
  untilTs: Ms,
  opts: { outdoorCo2?: number; volumeM3?: number } = {},
): { ts: Ms; co2: number }[] {
  const cout = opts.outdoorCo2 ?? DEFAULT_OUTDOOR_CO2;
  const vol = opts.volumeM3 ?? DEFAULT_VOLUME_M3;
  const rs = sortByTs(readings).filter((r) => plausibleCo2(r.co2));
  const last = rs[rs.length - 1];
  if (!last || untilTs <= last.ts) return [];
  const recent = rs.filter((r) => r.ts >= last.ts - 4 * HOUR);
  const okG = (g: number) => g >= 0.0005 && g <= 0.03;
  let ach = FALLBACK_ACH;
  let gen = FALLBACK_GEN_LPS;
  const free = fitBuildup(recent, { outdoorCo2: cout, volumeM3: vol });
  if (free && free.r2 >= 0.8 && free.ach >= 0.05 && free.ach <= 2 && okG(free.generationLps)) {
    ach = free.ach;
    gen = free.generationLps;
  } else {
    const fixed = fitBuildup(recent, { outdoorCo2: cout, volumeM3: vol, ach: FALLBACK_ACH });
    if (fixed && okG(fixed.generationLps)) gen = fixed.generationLps;
  }
  const c0 = median(rs.slice(-5).map((r) => r.co2));
  const css = cout + lpsToPpmPerHour(gen, vol) / ach;
  const out: { ts: Ms; co2: number }[] = [];
  const step = 5 * MIN;
  for (let ts = last.ts + step; ; ts += step) {
    const t = Math.min(ts, untilTs);
    const h = (t - last.ts) / HOUR;
    out.push({ ts: t, co2: Math.round(css - (css - c0) * Math.exp(-ach * h)) });
    if (t >= untilTs) break;
  }
  return out;
}

/**
 * Evening forecast before the sleepers' build-up can be fitted: the room follows its current trend (empty, decaying
 * towards outdoor at `ach`) until `occupiedFrom`, then builds up with `generationLps` (e.g. learned from earlier
 * nights) at the same ACH.
 */
export function forecastCo2Occupied(
  readings: RoomReading[],
  untilTs: Ms,
  opts: { occupiedFrom: Ms; generationLps: number; ach: number; outdoorCo2?: number; volumeM3?: number },
): { ts: Ms; co2: number }[] {
  const cout = opts.outdoorCo2 ?? DEFAULT_OUTDOOR_CO2;
  const vol = opts.volumeM3 ?? DEFAULT_VOLUME_M3;
  const rs = sortByTs(readings).filter((r) => plausibleCo2(r.co2));
  const last = rs[rs.length - 1];
  if (!last || untilTs <= last.ts) return [];
  const ach = Math.max(0.02, opts.ach);
  const gPpmH = lpsToPpmPerHour(opts.generationLps, vol);
  let c = median(rs.slice(-5).map((r) => r.co2));
  const out: { ts: Ms; co2: number }[] = [];
  const step = 5 * MIN;
  let prev = last.ts;
  for (let ts = last.ts + step; ; ts += step) {
    const t = Math.min(ts, untilTs);
    const css = t > opts.occupiedFrom ? cout + gPpmH / ach : cout;
    c = css + (c - css) * Math.exp(-ach * ((t - prev) / HOUR));
    prev = t;
    out.push({ ts: t, co2: Math.round(c) });
    if (t >= untilTs) break;
  }
  return out;
}

export interface PlateauAch {
  /** Air changes per hour that would hold CO₂ at `ppm` with two sleepers (FALLBACK_GEN_LPS) in the room. */
  ach: number;
  /** End-of-night CO₂ level: median of the last 15 min before wake. */
  ppm: number;
  /** CO₂ trend over the window, ppm/h (positive = still rising). */
  risePpmH: number;
  /**
   * 'plateau': CO₂ had levelled off (|rise| < PLATEAU_MAX_RISE), so `ach` is the estimate.
   * 'upper_bound': CO₂ was still rising, so the room never reached equilibrium and the true ACH is lower than `ach`.
   */
  kind: 'plateau' | 'upper_bound';
  /** Window used: the last `windowMin` minutes before wake. */
  from: Ms;
  to: Ms;
}

/** A CO₂ trend under this (ppm/h) counts as levelled off (the real 2026-10-30 night still rose 9.6 ppm/h: upper bound). */
export const PLATEAU_MAX_RISE = 5;

/**
 * Overnight ventilation from where CO₂ ends the night (the fallback when there is no clean morning decay). In a closed
 * room with steady occupancy CO₂ approaches C = Cout + G / (V·ACH), so ACH = G·3600 / V / (C − Cout). Uses the last
 * 90 min before wake (by then the room is closest to equilibrium); C = median of the last 15 min. When CO₂ is still
 * rising there the room never reached equilibrium and the figure is only an upper bound (kind 'upper_bound'). Returns
 * null with too little data in the window, when CO₂ is falling (someone left or a door opened: the formula doesn't
 * apply) or when it's within 150 ppm of outdoor air (a ventilated room: the formula is ill-conditioned).
 */
export function plateauAch(
  readings: readonly RoomReading[],
  wake: Ms,
  opts: { windowMin?: number; genLps?: number; volumeM3?: number; outdoorCo2?: number } = {},
): PlateauAch | null {
  const windowMin = opts.windowMin ?? 90;
  const outdoor = opts.outdoorCo2 ?? DEFAULT_OUTDOOR_CO2;
  const from = wake - windowMin * MIN;
  const rs = sortByTs(readings).filter((r) => r.ts >= from && r.ts < wake && plausibleCo2(r.co2));
  if (rs.length < 30 || rs[rs.length - 1]!.ts - rs[0]!.ts < (2 / 3) * windowMin * MIN) return null;
  // Least-squares trend, ppm/h.
  const t = rs.map((r) => (r.ts - from) / HOUR);
  const y = rs.map((r) => r.co2);
  const mt = t.reduce((a, b) => a + b, 0) / t.length;
  const my = y.reduce((a, b) => a + b, 0) / y.length;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < t.length; i++) { sxy += (t[i]! - mt) * (y[i]! - my); sxx += (t[i]! - mt) ** 2; }
  const rise = sxx > 0 ? sxy / sxx : 0;
  const ppm = median(rs.filter((r) => r.ts >= wake - 15 * MIN).map((r) => r.co2));
  if (!Number.isFinite(ppm) || ppm < outdoor + 150 || rise <= -PLATEAU_MAX_RISE) return null;
  const ach = lpsToPpmPerHour(opts.genLps ?? FALLBACK_GEN_LPS, opts.volumeM3 ?? DEFAULT_VOLUME_M3) / (ppm - outdoor);
  return {
    ach: Math.round(ach * 100) / 100,
    ppm: Math.round(ppm),
    risePpmH: Math.round(rise * 10) / 10,
    kind: rise < PLATEAU_MAX_RISE ? 'plateau' : 'upper_bound',
    from,
    to: wake,
  };
}
