import type { Ms, RoomReading } from '../types.ts';

export const MIN = 60_000;
export const HOUR = 3_600_000;
export const ICT_OFFSET_MS = 7 * HOUR;

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** 1 at x ≤ good, 0 at x ≥ bad (works for good > bad too), smoothstep in between. */
export function smoothScore(x: number, good: number, bad: number): number {
  if (!Number.isFinite(x)) return 0;
  const t = clamp((x - good) / (bad - good), 0, 1);
  return 1 - t * t * (3 - 2 * t);
}

export function mean(xs: readonly number[]): number {
  let s = 0;
  let n = 0;
  for (const x of xs) if (Number.isFinite(x)) { s += x; n++; }
  return n ? s / n : NaN;
}

export function sd(xs: readonly number[]): number {
  const f = xs.filter(Number.isFinite);
  if (f.length < 2) return NaN;
  const m = mean(f);
  return Math.sqrt(f.reduce((a, x) => a + (x - m) ** 2, 0) / (f.length - 1));
}

export function quantile(xs: readonly number[], q: number): number {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

export const median = (xs: readonly number[]) => quantile(xs, 0.5);

export function sortByTs<T extends { ts: Ms }>(xs: readonly T[]): T[] {
  return [...xs].sort((a, b) => a.ts - b.ts);
}

/** Local hour of day in ICT, fractional. */
export function ictHour(ts: Ms): number {
  return (((ts + ICT_OFFSET_MS) % (24 * HOUR)) + 24 * HOUR) % (24 * HOUR) / HOUR;
}

/** Epoch ms of HH:00 ICT on a YYYY-MM-DD local date. */
export function ictTime(date: string, hour: number): Ms {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!, hour) - ICT_OFFSET_MS;
}

/**
 * Regular 1-min grid of the readings. Gaps ≤ maxFillMin are linearly interpolated,
 * longer gaps stay NaN. Duplicate minutes are averaged.
 */
export interface MinuteGrid { t0: Ms; co2: number[]; rh: number[]; temp: number[] }

export function toMinuteGrid(readings: readonly RoomReading[], maxFillMin = 5): MinuteGrid | null {
  const rs = sortByTs(readings).filter((r) => Number.isFinite(r.ts));
  if (!rs.length) return null;
  const t0 = Math.round(rs[0]!.ts / MIN) * MIN;
  const n = Math.round((rs[rs.length - 1]!.ts - t0) / MIN) + 1;
  const acc = { co2: new Array<number>(n).fill(0), rh: new Array<number>(n).fill(0), temp: new Array<number>(n).fill(0) };
  const cnt = new Array<number>(n).fill(0);
  for (const r of rs) {
    const i = clamp(Math.round((r.ts - t0) / MIN), 0, n - 1);
    acc.co2[i]! += r.co2;
    acc.rh[i]! += r.rh;
    acc.temp[i]! += r.tempC;
    cnt[i]!++;
  }
  const fill = (a: number[]) => {
    const out = a.map((v, i) => (cnt[i] ? v / cnt[i]! : NaN));
    let last = -1;
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(out[i]!)) continue;
      const gap = i - last - 1;
      if (last >= 0 && gap > 0 && gap <= maxFillMin) {
        for (let k = last + 1; k < i; k++) out[k] = out[last]! + ((out[i]! - out[last]!) * (k - last)) / (i - last);
      }
      last = i;
    }
    return out;
  };
  return { t0, co2: fill(acc.co2), rh: fill(acc.rh), temp: fill(acc.temp) };
}

/** Centred rolling median over ±half samples, skipping NaN. */
export function rollingMedian(xs: readonly number[], half: number): number[] {
  return xs.map((x, i) => {
    if (!Number.isFinite(x)) return NaN;
    const w: number[] = [];
    for (let k = Math.max(0, i - half); k <= Math.min(xs.length - 1, i + half); k++) {
      const v = xs[k]!;
      if (Number.isFinite(v)) w.push(v);
    }
    return median(w);
  });
}

/** Theil–Sen slope (units per sample) over xs[lo..hi], using pairs at least minLag apart. */
export function theilSen(xs: readonly number[], lo: number, hi: number, minLag = 5): number {
  const slopes: number[] = [];
  for (let i = lo; i <= hi; i++) {
    const a = xs[i]!;
    if (!Number.isFinite(a)) continue;
    for (let j = i + minLag; j <= hi; j++) {
      const b = xs[j]!;
      if (Number.isFinite(b)) slopes.push((b - a) / (j - i));
    }
  }
  return slopes.length ? median(slopes) : NaN;
}

/** OLS line fit; returns SSE of the residuals (NaN-safe). */
export function lineSse(xs: readonly number[], lo: number, hi: number): { slope: number; sse: number; n: number } {
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = lo; i <= hi; i++) {
    const y = xs[i]!;
    if (!Number.isFinite(y)) continue;
    n++; sx += i; sy += y; sxx += i * i; sxy += i * y;
  }
  if (n < 3) return { slope: NaN, sse: Infinity, n };
  const den = n * sxx - sx * sx;
  const slope = den ? (n * sxy - sx * sy) / den : 0;
  const icpt = (sy - slope * sx) / n;
  let sse = 0;
  for (let i = lo; i <= hi; i++) {
    const y = xs[i]!;
    if (Number.isFinite(y)) sse += (y - (icpt + slope * i)) ** 2;
  }
  return { slope, sse, n };
}

/** Golden-section minimisation of f on [a, b]. */
export function goldenMin(f: (x: number) => number, a: number, b: number, iters = 60): number {
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a);
  let d = a + g * (b - a);
  let fc = f(c);
  let fd = f(d);
  for (let i = 0; i < iters; i++) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = f(c); }
    else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = f(d); }
  }
  return (a + b) / 2;
}

export function fmtDuration(min: number): string {
  const m = Math.round(min);
  const h = Math.floor(m / 60);
  return h ? `${h} h ${m % 60} m` : `${m} m`;
}
