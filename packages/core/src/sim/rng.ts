export interface Rng {
  /** Uniform [0, 1). */
  next(): number;
  normal(mean?: number, sd?: number): number;
  /** Integer in [min, max], inclusive. */
  int(min: number, max: number): number;
  chance(p: number): boolean;
  pick<T>(xs: readonly T[]): T;
}

/** Mulberry32: tiny, fast, good enough for synthetic data. Deterministic for a given seed. */
export function createRng(seed: number): Rng {
  let s = seed >>> 0;
  let spare: number | null = null;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    normal(mean = 0, sd = 1) {
      if (spare !== null) {
        const z = spare;
        spare = null;
        return mean + sd * z;
      }
      // Box–Muller; u kept away from 0 so log() is finite.
      const u = 1 - next();
      const v = next();
      const r = Math.sqrt(-2 * Math.log(u));
      spare = r * Math.sin(2 * Math.PI * v);
      return mean + sd * r * Math.cos(2 * Math.PI * v);
    },
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    chance(p) {
      return next() < p;
    },
    pick<T>(xs: readonly T[]): T {
      if (xs.length === 0) throw new Error('pick from empty array');
      return xs[Math.floor(next() * xs.length)]!;
    },
  };
  return rng;
}

/** Mixes several integers into one 32-bit seed (murmur3 finaliser per step). */
export function mixSeed(...parts: number[]): number {
  let h = 0x9e3779b9;
  for (const p of parts) {
    h = Math.imul(h ^ (p | 0), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return h >>> 0;
}
