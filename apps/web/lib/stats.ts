// Small statistics toolkit for the Lab views (pure, no deps).

export const finite = (xs: readonly number[]) => xs.filter((x) => Number.isFinite(x));

export function mean(xs: readonly number[]): number {
  const v = finite(xs);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
}

export function sd(xs: readonly number[]): number {
  const v = finite(xs);
  if (v.length < 2) return NaN;
  const m = mean(v);
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
}

export function quantile(xs: readonly number[], q: number): number {
  const v = finite(xs).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const i = (v.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return v[lo]! + (v[hi]! - v[lo]!) * (i - lo);
}
export const median = (xs: readonly number[]) => quantile(xs, 0.5);

/** Two-sided 95 % t critical value (good to ~1 % for df ≥ 2). */
export function t95(df: number): number {
  if (!Number.isFinite(df) || df <= 0) return NaN;
  const table: [number, number][] = [[1, 12.71], [2, 4.303], [3, 3.182], [4, 2.776], [5, 2.571], [6, 2.447], [8, 2.306], [10, 2.228], [15, 2.131], [20, 2.086], [30, 2.042], [60, 2.0], [120, 1.98]];
  for (let i = 0; i < table.length; i++) {
    const [d, t] = table[i]!;
    if (df <= d) {
      if (i === 0) return t;
      const [d0, t0] = table[i - 1]!;
      return t0 + ((df - d0) / (d - d0)) * (t - t0);
    }
  }
  return 1.96;
}

export function meanCI(xs: readonly number[]): { mean: number; lo: number; hi: number; n: number } {
  const v = finite(xs);
  const m = mean(v);
  const half = v.length > 1 ? (t95(v.length - 1) * sd(v)) / Math.sqrt(v.length) : NaN;
  return { mean: m, lo: m - half, hi: m + half, n: v.length };
}

/** Welch difference of means (b − a) with a 95 % interval. */
export function welch(a: readonly number[], b: readonly number[]) {
  const x = finite(a);
  const y = finite(b);
  const diff = mean(y) - mean(x);
  if (x.length < 2 || y.length < 2) return { diff, lo: NaN, hi: NaN, nA: x.length, nB: y.length };
  const va = sd(x) ** 2 / x.length;
  const vb = sd(y) ** 2 / y.length;
  const se = Math.sqrt(va + vb);
  const df = (va + vb) ** 2 / (va ** 2 / (x.length - 1) + vb ** 2 / (y.length - 1));
  const t = t95(df);
  return { diff, lo: diff - t * se, hi: diff + t * se, nA: x.length, nB: y.length };
}

export function pearson(xs: readonly number[], ys: readonly number[]): number {
  const pts = xs.map((x, i) => [x, ys[i]!] as const).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pts.length < 3) return NaN;
  const mx = mean(pts.map((p) => p[0]));
  const my = mean(pts.map((p) => p[1]));
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pts) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN;
}

export function linearFit(xs: readonly number[], ys: readonly number[]) {
  const pts = xs.map((x, i) => [x, ys[i]!] as const).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  const mx = mean(pts.map((p) => p[0]));
  const my = mean(pts.map((p) => p[1]));
  let sxy = 0, sxx = 0;
  for (const [x, y] of pts) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
  }
  const slope = sxx ? sxy / sxx : NaN;
  return { slope, intercept: my - slope * mx, n: pts.length };
}

/** LOESS (tricube weights, local linear) evaluated on `grid`. */
export function loess(xs: readonly number[], ys: readonly number[], grid: readonly number[], span = 0.6): { x: number; y: number }[] {
  const pts = xs.map((x, i) => [x, ys[i]!] as const).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  const n = pts.length;
  if (n < 5) return [];
  const k = Math.max(3, Math.ceil(span * n));
  return grid.map((g) => {
    const d = pts.map(([x]) => Math.abs(x - g)).sort((a, b) => a - b);
    const h = Math.max(d[k - 1]!, 1e-9);
    let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0;
    for (const [x, y] of pts) {
      const u = Math.abs(x - g) / h;
      if (u >= 1) continue;
      const w = (1 - u ** 3) ** 3;
      sw += w; swx += w * x; swy += w * y; swxx += w * x * x; swxy += w * x * y;
    }
    const den = sw * swxx - swx * swx;
    const y = Math.abs(den) < 1e-12 ? swy / sw : ((swy * swxx - swx * swxy) + (sw * swxy - swx * swy) * g) / den;
    return { x: g, y };
  });
}

export function rollingMean(xs: readonly number[], window: number): number[] {
  return xs.map((_, i) => mean(xs.slice(Math.max(0, i - window + 1), i + 1)));
}

/** Rolling baseline band from the *previous* `window` values (so today is judged against the past). */
export function rollingBand(xs: readonly number[], window = 30, minN = 5): { mean: number; lo: number; hi: number }[] {
  return xs.map((_, i) => {
    const past = finite(xs.slice(Math.max(0, i - window), i));
    if (past.length < minN) return { mean: NaN, lo: NaN, hi: NaN };
    const m = mean(past);
    const s = sd(past);
    return { mean: m, lo: m - s, hi: m + s };
  });
}

export const range = (lo: number, hi: number, n: number) => Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / Math.max(1, n - 1));
export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
