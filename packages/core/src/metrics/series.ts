import type { Ms } from '../types.ts';
import { mean, sd } from './util.ts';

/** Dew point (°C), Magnus formula (Sonntag 1990 constants). */
export function dewPointC(tempC: number, rh: number): number {
  const a = 17.62;
  const b = 243.12;
  const g = Math.log(Math.max(rh, 0.1) / 100) + (a * tempC) / (b + tempC);
  return (b * g) / (a - g);
}

/** Absolute humidity (g/m³) from temperature and RH. */
export function absoluteHumidityGm3(tempC: number, rh: number): number {
  const es = 6.112 * Math.exp((17.67 * tempC) / (tempC + 243.5));
  return (es * rh * 2.1674) / (273.15 + tempC);
}

/** Mean ± k·SD band over finite values (sample SD; 0 for a single value, NaN when empty). */
export function baselineBand(values: number[], k = 1): { mean: number; sd: number; lo: number; hi: number } {
  const f = values.filter(Number.isFinite);
  const m = mean(f);
  const s = f.length === 1 ? 0 : sd(f);
  return { mean: m, sd: s, lo: m - k * s, hi: m + k * s };
}

/**
 * Bucket by floor(ts / bucketMs) · bucketMs; the output ts is the bucket start.
 * 'mean' averages numeric fields (non-numeric fields come from the bucket's last item); 'last' keeps the last item.
 */
export function downsample<T extends { ts: Ms }>(xs: T[], bucketMs: number, pick: 'mean' | 'last'): T[] {
  if (!(bucketMs > 0)) return [...xs];
  const buckets = new Map<number, T[]>();
  for (const x of xs) {
    const key = Math.floor(x.ts / bucketMs) * bucketMs;
    const b = buckets.get(key);
    if (b) b.push(x);
    else buckets.set(key, [x]);
  }
  const out: T[] = [];
  for (const [key, items] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    const last = items.reduce((a, b) => (b.ts >= a.ts ? b : a));
    const row: Record<string, unknown> = { ...last };
    if (pick === 'mean') {
      for (const field of Object.keys(row)) {
        if (field === 'ts' || typeof row[field] !== 'number') continue;
        const vals = items.map((it) => (it as Record<string, unknown>)[field]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
        if (vals.length) row[field] = vals.reduce((a, v) => a + v, 0) / vals.length;
      }
    }
    row.ts = key;
    out.push(row as T);
  }
  return out;
}
