import { describe, expect, it } from 'vitest';
import type { RoomReading } from '../src/types.ts';
import {
  absoluteHumidityGm3, baselineBand, dewPointC, downsample, fitBuildup, fitDecayAch, forecastCo2, forecastCo2Occupied,
} from '../src/metrics/index.ts';

const MIN = 60_000;
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 27, 11); // 18:00 ICT

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = (sd = 1) => sd * Math.sqrt(-2 * Math.log(next() || 1e-12)) * Math.cos(2 * Math.PI * next());
  return { next, normal };
}

/** Integer-quantised 1-min readings from a CO₂ function, with noise and missing minutes. */
function readings(minutes: number, co2: (h: number) => number, o: { seed?: number; noise?: number; missing?: number; start?: number } = {}): RoomReading[] {
  const r = rng(o.seed ?? 1);
  const out: RoomReading[] = [];
  for (let i = 0; i < minutes; i++) {
    if (r.next() < (o.missing ?? 0)) continue;
    out.push({ ts: (o.start ?? T0) + i * MIN, co2: Math.round(co2(i / 60) + r.normal(o.noise ?? 0)), tempC: 22, rh: 55, source: 'sim' });
  }
  return out;
}

/** Euler integration of the mass balance with 1-min steps. */
function massBalance(hours: number, o: { ach: number; genLps: number; c0: number; vol?: number }) {
  const vol = o.vol ?? 120;
  const c = [o.c0];
  for (let i = 1; i <= hours * 60; i++) {
    const prev = c[i - 1]!;
    c.push(prev + ((o.genLps * 3.6e6) / vol - o.ach * (prev - 425)) / 60);
  }
  return (h: number) => c[Math.min(c.length - 1, Math.round(h * 60))]!;
}

describe('psychrometrics', () => {
  it('dew point and absolute humidity match reference values', () => {
    expect(dewPointC(25, 50)).toBeCloseTo(13.9, 1);
    expect(dewPointC(30, 80)).toBeCloseTo(26.2, 1);
    expect(absoluteHumidityGm3(25, 50)).toBeCloseTo(11.5, 1);
    expect(absoluteHumidityGm3(20, 100)).toBeCloseTo(17.3, 1);
  });
});

describe('fitDecayAch', () => {
  it('recovers ACH from a noisy, quantised decay after an overnight rise', () => {
    // 3 h rise, then 6 h decay at ACH 0.4 toward 425.
    const f = (h: number) => (h < 3 ? 600 + 300 * h : 425 + 1075 * Math.exp(-0.4 * (h - 3)));
    const rs = readings(9 * 60, f, { noise: 6, missing: 0.03, seed: 3 });
    const fit = fitDecayAch(rs)!;
    expect(fit).not.toBeNull();
    expect(fit.ach).toBeGreaterThan(0.35);
    expect(fit.ach).toBeLessThan(0.45);
    expect(fit.r2).toBeGreaterThan(0.95);
    expect(Math.abs(fit.start - (T0 + 3 * HOUR))).toBeLessThanOrEqual(5 * MIN);
  });

  it('fits a non-default baseline when the decay is long enough to show it', () => {
    const rs = readings(6 * 60, (h) => 480 + 1200 * Math.exp(-0.8 * h), { noise: 4, seed: 5 });
    const fit = fitDecayAch(rs)!;
    expect(fit.baseline).toBeGreaterThan(465);
    expect(fit.baseline).toBeLessThan(495);
    expect(fit.ach).toBeCloseTo(0.8, 1);
  });

  it('keeps the outdoor baseline for a short, shallow-curvature decay', () => {
    const rs = readings(90, (h) => 425 + 1200 * Math.exp(-0.2 * h), { noise: 3, seed: 6 });
    const fit = fitDecayAch(rs)!;
    expect(fit.baseline).toBe(425);
    expect(fit.ach).toBeGreaterThan(0.15);
    expect(fit.ach).toBeLessThan(0.25);
  });

  it('does not let a long door opening at the start inflate ACH', () => {
    // 30 min at ACH 3.2 (door open), then the closed room at 0.2.
    const atDoorClose = 1100 * Math.exp(-3.2 * 0.5);
    const f = (h: number) => (h < 0.5 ? 425 + 1100 * Math.exp(-3.2 * h) : 425 + atDoorClose * Math.exp(-0.2 * (h - 0.5)));
    const fit = fitDecayAch(readings(5 * 60, f, { noise: 3, seed: 8 }));
    if (fit) {
      expect(fit.ach).toBeLessThan(0.3);
      expect(fit.start).toBeGreaterThanOrEqual(T0 + 25 * MIN);
    }
  });

  it('rejects flat, noisy, too-short and too-small windows', () => {
    expect(fitDecayAch(readings(600, () => 700, { noise: 10, seed: 7 }))).toBeNull();
    expect(fitDecayAch(readings(600, () => 425, { noise: 3, seed: 7 }))).toBeNull();
    expect(fitDecayAch(readings(300, (h) => 425 + 120 * Math.exp(-0.5 * h), { noise: 3 }))).toBeNull();
    expect(fitDecayAch(readings(40, (h) => 425 + 1000 * Math.exp(-0.5 * h)))).toBeNull();
    expect(fitDecayAch([])).toBeNull();
  });

  it('respects minMinutes', () => {
    const rs = readings(40, (h) => 425 + 1000 * Math.exp(-0.6 * h), { noise: 2 });
    expect(fitDecayAch(rs, { minMinutes: 30 })).not.toBeNull();
  });
});

describe('fitBuildup', () => {
  const truth = massBalance(8, { ach: 0.2, genLps: 0.0062, c0: 500 });
  const rs = readings(8 * 60, truth, { noise: 8, missing: 0.03, seed: 11 });

  it('recovers generation rate and ACH from an overnight rise', () => {
    const fit = fitBuildup(rs)!;
    expect(fit.r2).toBeGreaterThan(0.98);
    expect(fit.generationLps).toBeGreaterThan(0.0062 * 0.85);
    expect(fit.generationLps).toBeLessThan(0.0062 * 1.15);
    expect(fit.ach).toBeGreaterThan(0.12);
    expect(fit.ach).toBeLessThan(0.28);
  });

  it('is accurate for G when ACH is given', () => {
    const fit = fitBuildup(rs, { ach: 0.2 })!;
    expect(fit.ach).toBe(0.2);
    expect(fit.generationLps).toBeCloseTo(0.0062, 3);
  });

  it('scales with volume', () => {
    const t = massBalance(6, { ach: 0.3, genLps: 0.004, c0: 450, vol: 60 });
    const fit = fitBuildup(readings(360, t, { noise: 3 }), { volumeM3: 60, ach: 0.3 })!;
    expect(fit.generationLps).toBeCloseTo(0.004, 3);
  });

  it('returns null with too little data', () => {
    expect(fitBuildup(rs.slice(0, 10))).toBeNull();
  });
});

describe('forecastCo2', () => {
  it('projects the rest of the night close to the truth', () => {
    const truth = massBalance(8, { ach: 0.25, genLps: 0.007, c0: 520 });
    const sofar = readings(180, truth, { noise: 6, seed: 21 });
    const until = T0 + 8 * HOUR;
    const fc = forecastCo2(sofar, until);
    expect(fc.length).toBeGreaterThan(50);
    expect(fc[fc.length - 1]!.ts).toBe(until);
    for (let i = 1; i < fc.length; i++) expect(fc[i]!.ts).toBeGreaterThan(fc[i - 1]!.ts);
    expect(Math.abs(fc[fc.length - 1]!.co2 - truth(8))).toBeLessThan(150);
  });

  it('falls back to default parameters on an uninformative history', () => {
    const fc = forecastCo2(readings(20, () => 600, { noise: 2 }), T0 + 4 * HOUR);
    expect(fc.length).toBeGreaterThan(0);
    // ACH 0.2 and 0.0062 L/s rise from 600 toward ≈1355.
    expect(fc[fc.length - 1]!.co2).toBeGreaterThan(700);
    expect(fc[fc.length - 1]!.co2).toBeLessThan(1355);
  });

  it('returns [] when there is nothing to forecast', () => {
    expect(forecastCo2([], T0 + HOUR)).toEqual([]);
    const rs = readings(60, () => 600);
    expect(forecastCo2(rs, rs[rs.length - 1]!.ts)).toEqual([]);
  });
});

describe('forecastCo2Occupied', () => {
  it('decays while empty, then builds up from the expected lights-out', () => {
    const empty = readings(60, () => 520, { noise: 0 });
    const lo = T0 + 4 * HOUR;
    const fc = forecastCo2Occupied(empty, T0 + 12 * HOUR, { occupiedFrom: lo, generationLps: 0.0062, ach: 0.2 });
    const at = (ts: number) => fc.find((p) => p.ts >= ts)!.co2;
    expect(at(lo)).toBeLessThan(520);
    // 7.5 h of two sleepers at ACH 0.2: most of the way to the 1355 ppm steady state.
    expect(fc.at(-1)!.co2).toBeGreaterThan(1100);
    expect(fc.at(-1)!.co2).toBeLessThan(1355);
  });
});

describe('baselineBand', () => {
  it('computes mean ± k·sd, ignoring non-finite values', () => {
    const b = baselineBand([10, 12, 14, NaN], 2);
    expect(b.mean).toBe(12);
    expect(b.sd).toBe(2);
    expect(b.lo).toBe(8);
    expect(b.hi).toBe(16);
    expect(baselineBand([5]).sd).toBe(0);
    expect(Number.isNaN(baselineBand([]).mean)).toBe(true);
  });
});

describe('downsample', () => {
  const xs = [
    { ts: 0, v: 1, s: 'a' },
    { ts: 30_000, v: 3, s: 'b' },
    { ts: 60_000, v: 10, s: 'c' },
    { ts: 150_000, v: 7, s: 'd' },
  ];
  it('averages numeric fields per bucket', () => {
    expect(downsample(xs, MIN, 'mean')).toEqual([
      { ts: 0, v: 2, s: 'b' },
      { ts: 60_000, v: 10, s: 'c' },
      { ts: 120_000, v: 7, s: 'd' },
    ]);
  });
  it('keeps the last item per bucket', () => {
    expect(downsample(xs, 2 * MIN, 'last')).toEqual([
      { ts: 0, v: 10, s: 'c' },
      { ts: 120_000, v: 7, s: 'd' },
    ]);
  });
});
