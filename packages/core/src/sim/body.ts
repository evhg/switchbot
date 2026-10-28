import type { HrSample, HrvSample, PersonNight, SleepStage, Spo2Sample, StageSegment, TagKey } from '../types.ts';
import { nightRng, poisson, type NightPlan, type PersonPlan } from './plan.ts';
import type { RoomSim } from './room.ts';
import { MIN } from './time.ts';

const EPOCH = 30_000;
const DEEP_W = [0.42, 0.3, 0.14, 0.05, 0.02];
const REM_W = [0.09, 0.18, 0.25, 0.3, 0.34, 0.36];
const STAGE_HR: Record<SleepStage, number> = { awake: 9, rem: 4, light: 1, deep: -1.5 };
const STAGE_HRV: Record<SleepStage, number> = { awake: 0.7, rem: 0.85, light: 1, deep: 1.25 };

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

function meanOver(xs: Float64Array, from: number, to: number): number {
  let s = 0;
  let n = 0;
  for (let i = Math.max(0, from); i < Math.min(xs.length, to); i++) {
    s += xs[i]!;
    n++;
  }
  return n ? s / n : NaN;
}

/** Environment the sleeper was exposed to; drives the effect sizes in docs/research/sleep-science.md. */
export interface Exposure {
  earlyTempC: number;
  co2Mean: number;
  rhOver60Min: number;
}

export function simulateBody(plan: NightPlan, p: PersonPlan, room: RoomSim, seed: number): PersonNight {
  const rng = nightRng(seed, plan.date, 100 + p.index);
  const tags = new Set<TagKey>(plan.tags);
  const alcohol = tags.has('alcohol');
  const lateMeal = tags.has('late_meal');
  const t0 = plan.t0;
  const onset = p.bedIn + p.latency;
  const finalWake = Math.max(onset + 180, p.rise - rng.int(2, 12));
  const sleepMin = finalWake - onset;

  let rhOver60 = 0;
  for (let m = onset; m < finalWake; m++) if ((room.rhTrue[m] ?? 0) > 60) rhOver60++;
  const exp: Exposure = {
    earlyTempC: meanOver(room.tempTrue, onset, onset + 240) + (tags.has('heavy_duvet') ? 1.5 : 0),
    co2Mean: meanOver(room.co2True, onset, finalWake),
    rhOver60Min: rhOver60,
  };
  const warm = exp.earlyTempC;
  const co2Excess = Math.max(0, exp.co2Mean - 750);

  // Deep-sleep budget: ~7 min/°C around 19.5 (6 more per °C above 21), ~1.2 min per +100 ppm CO2.
  const deepDelta =
    p.profile.deepBiasMin +
    rng.normal(0, 11) -
    7 * clamp(warm - 19.5, -1.5, 6) -
    6 * Math.max(0, warm - 21) -
    (1.2 * co2Excess) / 100 -
    (tags.has('late_caffeine') ? 8 : 0) -
    (p.sick ? 10 : 0) +
    (tags.has('late_exercise') ? 3 : 0);
  const deepScale = clamp(1 + deepDelta / 80, 0.35, 1.6);
  const remScale = clamp(1 + rng.normal(0, 0.12) - (alcohol ? 0.2 : 0) - (p.sick ? 0.1 : 0), 0.5, 1.4);

  const n = sleepMin * 2;
  const ep: SleepStage[] = new Array(n).fill('light');
  const boundaries: number[] = [];
  let pos = 0;
  for (let k = 0; pos < n; k++) {
    const len = Math.round(clamp(rng.normal(k === 0 ? 85 : 93, 11), 70, 115) * 2);
    const dw = Math.min(0.6, (DEEP_W[k] ?? 0) * deepScale * Math.exp(rng.normal(0, 0.15)));
    const rw = Math.min(0.5, (REM_W[k] ?? 0.36) * remScale * Math.exp(rng.normal(0, 0.15)));
    const lw = 1 - dw - rw;
    const la = Math.round(len * lw * 0.55);
    const d = Math.round(len * dw);
    const lb = Math.round(len * lw * 0.45);
    const r = len - la - d - lb;
    let i = pos + la;
    for (let j = 0; j < d && i < n; j++, i++) ep[i] = 'deep';
    if (d > 20 && rng.chance(0.5)) {
      const mid = pos + la + Math.floor(d / 2);
      for (let j = 0; j < rng.int(1, 3) && mid + j < n; j++) ep[mid + j] = 'light';
    }
    i += lb;
    for (let j = 0; j < r && i < n; j++, i++) ep[i] = 'rem';
    pos += len;
    boundaries.push(Math.min(n - 1, pos));
  }
  const setAwake = (from: number, len: number) => {
    for (let j = Math.max(0, from); j < Math.min(n, from + len); j++) ep[j] = 'awake';
  };
  const lambda = 0.35 * (sleepMin / 60) + rhOver60 / 90 + (p.sick ? 3 : 0) + (alcohol ? 1 : 0);
  const wakes = poisson(rng, lambda);
  for (let k = 0; k < wakes; k++) {
    const at = rng.chance(0.6) && boundaries.length ? rng.pick(boundaries) : rng.int(0, n - 1);
    // Alcohol fragments the second half.
    const shifted = alcohol && at < n / 2 && rng.chance(0.5) ? at + Math.floor(n / 2) : at;
    setAwake(shifted, rng.int(2, 8));
  }
  for (const t of p.trips) setAwake((t.start - 1 - onset) * 2, (t.end - t.start + 2) * 2);

  // Stage per minute over the whole session (bedIn → rise).
  const stageAtMin = (m: number): SleepStage => {
    if (m < onset || m >= finalWake) return 'awake';
    return ep[(m - onset) * 2] ?? 'awake';
  };

  const stages: StageSegment[] = [];
  const push = (start: number, end: number, stage: SleepStage) => {
    const last = stages[stages.length - 1];
    if (last && last.stage === stage && last.end === start) last.end = end;
    else stages.push({ start, end, stage });
  };
  const onsetMs = t0 + onset * MIN;
  push(t0 + p.bedIn * MIN, onsetMs, 'awake');
  for (let i = 0; i < n; i++) push(onsetMs + i * EPOCH, onsetMs + (i + 1) * EPOCH, ep[i]!);
  push(t0 + finalWake * MIN, t0 + p.rise * MIN, 'awake');

  // HR: 1 sample/min (real Fitbit data is ~5 s). Declines to a nadir in the 2nd–3rd quarter.
  const nadir =
    p.profile.hrNadir +
    1.2 * clamp(warm - 19.5, -1, 6) +
    (alcohol ? 3 + 5 * rng.next() : 0) +
    (lateMeal ? 3 + 3 * rng.next() : 0) +
    (tags.has('late_exercise') ? 2 : 0) +
    (p.sick ? 6 : 0) +
    rng.normal(0, 1.5);
  const xn = Math.min(0.88, clamp(rng.normal(0.52, 0.07), 0.38, 0.68) + (alcohol ? 0.12 + 0.08 * rng.next() : 0) + (lateMeal ? 0.08 + 0.07 * rng.next() : 0));
  const startHr = nadir + 9 + rng.normal(0, 1.5);
  const endRise = 4 + rng.normal(0, 1);
  const hr: HrSample[] = [];
  let e = 0;
  for (let m = p.bedIn; m < p.rise; m++) {
    const x = (m - onset) / sleepMin;
    const base =
      x < 0 ? startHr + 4 : x < xn ? nadir + (startHr - nadir) * Math.pow(1 - x / xn, 1.6) : nadir + endRise * Math.pow(Math.min(1, (x - xn) / (1 - xn)), 1.4);
    e = 0.7 * e + rng.normal(0, 1);
    hr.push({ ts: t0 + m * MIN, bpm: Math.round(base + STAGE_HR[stageAtMin(m)] + e) });
  }

  // HRV: RMSSD per 5-min window while asleep.
  const rmssdNight =
    p.profile.rmssd *
    Math.exp(rng.normal(0, 0.08)) *
    (1 - 0.04 * clamp(warm - 19.5, -1, 6)) *
    (alcohol ? 0.78 : 1) *
    (lateMeal ? 0.9 : 1) *
    (p.sick ? 0.75 : 1) -
    (1.5 * co2Excess) / 500;
  const hrv: HrvSample[] = [];
  for (let m = onset; m + 5 <= finalWake; m += 5) {
    const counts: Record<SleepStage, number> = { awake: 0, light: 0, deep: 0, rem: 0 };
    for (let j = 0; j < 5; j++) counts[stageAtMin(m + j)]++;
    if (counts.awake >= 3) continue;
    const st = (Object.keys(counts) as SleepStage[]).reduce((a, b) => (counts[b] > counts[a] ? b : a));
    const x = (m - onset) / sleepMin;
    const v = rmssdNight * STAGE_HRV[st] * (0.92 + 0.16 * Math.min(1, x / xn)) * Math.exp(rng.normal(0, 0.12));
    hrv.push({ ts: t0 + m * MIN, rmssdMs: Math.round(Math.max(8, v) * 10) / 10 });
  }

  // SpO2 per minute: night-to-night baseline wobble, and desaturations with a 1–2 min descent, short
  // nadir and 1–3 min recovery. Depth is continuous (2–6 % below baseline); some nights have none.
  const spo2: Spo2Sample[] = [];
  const quiet = rng.chance(alcohol || p.sick ? 0.08 : 0.25);
  const dipP = quiet ? 0 : (0.4 + 1.4 * rng.next()) * (alcohol ? 2 : 1) * (p.sick ? 1.5 : 1) / 60;
  const spBase = p.profile.spo2 - (p.sick ? 0.8 : 0) + rng.normal(0, 0.45);
  const dipShape: number[] = [];
  let dipIdx = 0;
  for (let m = onset; m < finalWake; m++) {
    if (dipIdx >= dipShape.length && rng.chance(dipP)) {
      const depth = 2 + 4 * Math.pow(rng.next(), 1.4);
      const down = rng.int(1, 2);
      const hold = rng.int(0, 2);
      const up = rng.int(1, 3);
      dipShape.length = 0;
      for (let j = 1; j <= down; j++) dipShape.push((depth * j) / down);
      for (let j = 0; j < hold; j++) dipShape.push(depth * (0.9 + 0.1 * rng.next()));
      for (let j = up - 1; j >= 0; j--) dipShape.push((depth * j) / up);
      dipIdx = 0;
    }
    const dip = dipIdx < dipShape.length ? dipShape[dipIdx++]! : 0;
    spo2.push({ ts: t0 + m * MIN, pct: Math.round(clamp(spBase + rng.normal(0, 0.5) - dip, 85, 100)) });
  }

  const respRate = Math.round((p.profile.respRate + rng.normal(0, 0.3) + (p.sick ? 1.5 : 0) + (alcohol ? 0.4 : 0)) * 10) / 10;
  const tempDeviationC =
    Math.round((rng.normal(0, 0.12) + (p.sick ? 0.6 : 0) + (alcohol ? 0.15 : 0) + 0.05 * (warm - 20)) * 100) / 100;

  return {
    personId: p.person.id,
    sleep: {
      personId: p.person.id,
      start: t0 + p.bedIn * MIN,
      end: t0 + p.rise * MIN,
      stages,
      updateTime: t0 + (p.rise + 90) * MIN,
    },
    hr,
    hrv,
    spo2,
    respRate,
    tempDeviationC,
  };
}
