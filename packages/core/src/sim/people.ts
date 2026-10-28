import type { Person } from '../types.ts';

export const DEFAULT_PEOPLE: Person[] = [
  // The app lets each household rename people (System → People); these are only defaults.
  { id: 'a', name: 'You', colorKey: 'personA' },
  { id: 'b', name: 'Erik', colorKey: 'personB' },
];

/** Physiological constants for one simulated sleeper. */
export interface BodyProfile {
  /** CO2 generation while asleep, L/s (Persily & de Jonge 2017 at ~0.95 met). */
  co2Lps: number;
  /** Typical sleeping HR nadir, bpm. */
  hrNadir: number;
  /** Typical sleep RMSSD, ms. */
  rmssd: number;
  spo2: number;
  respRate: number;
  latencyMin: number;
  /** Personal deep-sleep offset vs the population pattern, min. */
  deepBiasMin: number;
  /** Typical weekday step count; weekends and exercise days shift it. */
  stepsMean: number;
  /** Weekend steps as a multiple of weekday steps. */
  weekendSteps: number;
  /** Resting HR (Google daily-resting-heart-rate) minus the sleeping nadir, bpm. */
  rhrOverNadir: number;
}

const PROFILES: BodyProfile[] = [
  // ~80 kg adult; desk job, more active at weekends
  { co2Lps: 0.0034, hrNadir: 51, rmssd: 46, spo2: 96, respRate: 14.4, latencyMin: 11, deepBiasMin: 4, stepsMean: 7800, weekendSteps: 1.25, rhrOverNadir: 4 },
  // ~60 kg adult; walks more on weekdays
  { co2Lps: 0.0026, hrNadir: 56, rmssd: 38, spo2: 96.6, respRate: 15.3, latencyMin: 17, deepBiasMin: -2, stepsMean: 9400, weekendSteps: 0.85, rhrOverNadir: 3.5 },
];

export function profileFor(index: number): BodyProfile {
  const base = PROFILES[index % PROFILES.length]!;
  if (index < PROFILES.length) return base;
  // Extra people: small deterministic variation on the cycle.
  const k = Math.floor(index / PROFILES.length);
  return { ...base, hrNadir: base.hrNadir + 2 * k, rmssd: base.rmssd - 3 * k, co2Lps: base.co2Lps * (1 - 0.04 * k) };
}
