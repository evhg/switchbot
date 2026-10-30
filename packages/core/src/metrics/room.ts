import { scoringCurve, targetAt } from '../curve.ts';
import type { Night, RoomNightMetrics, TemperatureCurve } from '../types.ts';
import { plausibleCo2 } from '../switchbot/parse.ts';
import { fitDecayAch, plateauAch } from './co2.ts';
import { HOUR, MIN, ictTime, quantile, smoothScore, sortByTs } from './util.ts';

/**
 * Sleep Air score weights (sum 1). CO₂ dominates because it is the factor most likely out of range in
 * a sealed room; temperature adherence to the curve next; RH and stability are secondary.
 */
export const SLEEP_AIR_WEIGHTS = { co2: 0.4, temp: 0.35, rh: 0.15, stability: 0.1 } as const;

export interface RoomScoreParts {
  /** Sub-scores 0..1. */
  co2: number;
  temp: number;
  rh: number;
  stability: number;
  tempMeanAbsErr: number;
  /** SD of (temperature − curve target), °C. */
  tempSd: number;
  minutes: number;
  /** Share of lights-out → wake covered by readings, 0..1. */
  coverage: number;
  /** Aircon run by hand (Night.manual): temperature was scored against the comfort target, not the stored plan. */
  manual: boolean;
}

/** Below this coverage the night's room metrics are NaN and the report says there's not enough data. */
export const MIN_ROOM_COVERAGE = 0.5;

const TEMP_TOLERANCE_C = 0.75;
/** Each reading stands for the time to the next one, capped so long gaps don't count as data. */
const MAX_STEP_MIN = 5;

export function roomNightBreakdown(night: Night, plan: TemperatureCurve): { metrics: RoomNightMetrics; parts: RoomScoreParts } {
  // A night run by hand is judged against the steady comfort target: its stored plan never ran.
  const curve = scoringCurve(night, plan);
  const rs = sortByTs(night.room).filter((r) => r.ts >= night.lightsOut && r.ts < night.wake);
  let minutes = 0;
  let co2Sum = 0, co2W = 0, tempSum = 0, rhSum = 0, earlySum = 0, earlyW = 0, errSum = 0, errW = 0;
  let over1000 = 0, over1500 = 0, inTarget = 0, over24 = 0, rhOver60 = 0, rhBand = 0;
  let co2Max = -Infinity;
  const errs: number[] = [];
  for (let i = 0; i < rs.length; i++) {
    const r = rs[i]!;
    const next = rs[i + 1];
    const w = next ? Math.min(MAX_STEP_MIN, (next.ts - r.ts) / MIN) : 1;
    minutes += w;
    // The meter's 0 ppm warm-up artifact (< 300 ppm) is not a CO2 value; temp and RH of that minute still count.
    if (plausibleCo2(r.co2)) {
      co2Sum += r.co2 * w;
      co2W += w;
      co2Max = Math.max(co2Max, r.co2);
      if (r.co2 > 1000) over1000 += w;
      if (r.co2 > 1500) over1500 += w;
    }
    tempSum += r.tempC * w;
    rhSum += r.rh * w;
    if (r.tempC > 24) over24 += w;
    if (r.rh > 60) rhOver60 += w;
    if (r.rh >= 45 && r.rh <= 55) rhBand += w;
    if (r.ts < night.lightsOut + 4 * HOUR) { earlySum += r.tempC * w; earlyW += w; }
    const target = targetAt(curve, night.lightsOut, r.ts, night.sleepOnset);
    if (target !== null) {
      errs.push(r.tempC - target);
      const err = Math.abs(r.tempC - target);
      errSum += err * w;
      errW += w;
      if (err <= TEMP_TOLERANCE_C) inTarget += w;
    }
  }
  const coverage = Math.min(1, minutes / Math.max(1, (night.wake - night.lightsOut) / MIN));
  // A meter that dropped out overnight must not turn into "Sleep Air 0, mean 0 ppm".
  const has = minutes > 0 && coverage >= MIN_ROOM_COVERAGE;
  const tempMean = has ? tempSum / minutes : NaN;
  // Stability = spread of the error around its mean, so planned curve steps don't count as instability.
  const errMean = errs.length ? errs.reduce((a, e) => a + e, 0) / errs.length : 0;
  const tempSd = errs.length ? Math.sqrt(errs.reduce((a, e) => a + (e - errMean) ** 2, 0) / errs.length) : 0;
  const co2Mean = has && co2W > 0 ? co2Sum / co2W : NaN;
  const frac = (m: number) => (has ? m / minutes : 0);
  const tempMeanAbsErr = errW ? errSum / errW : NaN;

  const noon = Math.max(ictTime(night.date, 12), night.wake + 2 * HOUR);
  const decay = fitDecayAch(night.room.filter((r) => r.ts >= night.wake && r.ts <= noon));
  const plateau = has ? plateauAch(night.room, night.wake) : null;

  // Sub-scores (0..1), each a smooth penalty curve.
  const parts: RoomScoreParts = {
    co2: has && co2W > 0 ? 0.5 * smoothScore(co2Mean, 700, 1400) + 0.3 * (1 - over1000 / co2W) + 0.2 * (1 - over1500 / co2W) : 0,
    temp: has ? 0.7 * frac(inTarget) + 0.3 * smoothScore(tempMeanAbsErr, 0.3, 2) : 0,
    rh: has ? 0.6 * frac(rhBand) + 0.4 * (1 - frac(rhOver60)) : 0,
    stability: has ? 0.6 * (1 - frac(over24)) + 0.4 * smoothScore(tempSd, 0.5, 2) : 0,
    tempMeanAbsErr,
    tempSd,
    minutes,
    coverage,
    manual: night.manual === true,
  };
  const W = SLEEP_AIR_WEIGHTS;
  const score = !has ? NaN : 100 * (W.co2 * parts.co2 + W.temp * parts.temp + W.rh * parts.rh + W.stability * parts.stability);

  const metrics: RoomNightMetrics = {
    date: night.date,
    co2Mean: Math.round(co2Mean),
    co2P95: has ? Math.round(quantile(rs.filter((r) => plausibleCo2(r.co2)).map((r) => r.co2), 0.95)) : NaN,
    co2Max: has && co2W > 0 ? co2Max : NaN,
    minutesCo2Over1000: Math.round(over1000),
    minutesCo2Over1500: Math.round(over1500),
    tempMean: Math.round(tempMean * 100) / 100,
    tempEarlyMean: has && earlyW ? Math.round((earlySum / earlyW) * 100) / 100 : NaN,
    minutesTempInTarget: Math.round(inTarget),
    minutesTempOver24: Math.round(over24),
    rhMean: has ? Math.round((rhSum / minutes) * 10) / 10 : NaN,
    minutesRhOver60: Math.round(rhOver60),
    minutesRhInBand: Math.round(rhBand),
    achMorning: decay ? Math.round(decay.ach * 1000) / 1000 : null,
    achPlateau: plateau?.ach ?? null,
    achPlateauKind: plateau?.kind ?? null,
    achPlateauPpm: plateau?.ppm ?? null,
    sleepAirScore: Math.round(score),
    acCommands: night.ac.length,
  };
  return { metrics, parts };
}

/** Room metrics over lights-out → wake. See SLEEP_AIR_WEIGHTS for the score (manual nights: see scoringCurve). */
export function roomNightMetrics(night: Night, curve: TemperatureCurve): RoomNightMetrics {
  return roomNightBreakdown(night, curve).metrics;
}
