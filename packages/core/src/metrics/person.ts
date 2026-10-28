import type { HrSample, Ms, Night, PersonNight, PersonNightMetrics, StageSegment } from '../types.ts';
import { MIN, clamp, mean, median, sd, smoothScore } from './util.ts';

/** Sleep score weights: duration vs 7.5 h, efficiency, deep+REM share, awakenings. */
export const SLEEP_SCORE_WEIGHTS = { duration: 0.35, efficiency: 0.25, restorative: 0.25, awakenings: 0.15 } as const;
/** Recovery (Whoop/Pulse-style) weights; missing inputs are dropped and the rest renormalised. */
export const RECOVERY_WEIGHTS = { hrv: 0.4, hr: 0.25, sleep: 0.25, resp: 0.1 } as const;
export const RECOVERY_NEUTRAL = 70;
export const BASELINE_NIGHTS = 30;
export const MIN_BASELINE_NIGHTS = 7;
const SLEEP_NEED_MIN = 450;

export interface PersonScoreParts {
  sleep: { duration: number; efficiency: number; restorative: number; awakenings: number };
  /** Sub-scores 0..100 and z-scores vs the personal baseline; null when there was no usable baseline. */
  recovery: {
    hrvZ: number | null;
    hrZ: number | null;
    respDev: number | null;
    baselineNights: number;
    baseline: { rmssd: number; hrNadir: number; respRate: number; deepMin: number; remMin: number; totalSleepMin: number } | null;
  };
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const inAny = (ts: Ms, segs: readonly StageSegment[]) => segs.some((s) => ts >= s.start && ts < s.end);

/** Centred time-window rolling median; robust to single-sample artifacts. */
function rollingMedianTs<T extends { ts: Ms }>(xs: readonly T[], val: (x: T) => number, halfMs: number): number[] {
  let lo = 0;
  let hi = 0;
  return xs.map((x) => {
    while (xs[lo]!.ts < x.ts - halfMs) lo++;
    while (hi < xs.length && xs[hi]!.ts <= x.ts + halfMs) hi++;
    return median(xs.slice(lo, hi).map(val));
  });
}

/** z-score → 0..100 with z = 0 mapping to ≈ 67 (an ordinary night is "good", not "average"). */
const zSub = (z: number) => 100 / (1 + Math.exp(-(1.2 * z + 0.7)));

interface Base { m: PersonNightMetrics; sleepParts: PersonScoreParts['sleep'] }

function baseMetrics(date: string, pn: PersonNight): Base {
  const segs = [...pn.sleep.stages].sort((a, b) => a.start - b.start);
  const dur = (s: StageSegment) => Math.max(0, s.end - s.start) / MIN;
  const byStage = { awake: 0, light: 0, deep: 0, rem: 0 };
  for (const s of segs) byStage[s.stage] += dur(s);
  const asleep = segs.filter((s) => s.stage !== 'awake');
  const onset = asleep[0]?.start ?? pn.sleep.end;
  const sleepEnd = asleep.length ? Math.max(...asleep.map((s) => s.end)) : pn.sleep.end;
  const total = byStage.light + byStage.deep + byStage.rem;
  const inBedMin = Math.max(1, (pn.sleep.end - pn.sleep.start) / MIN);

  // Awakenings: merged awake runs ≥ 2 min strictly between sleep onset and final awakening.
  let awakenings = 0;
  let run: { start: Ms; end: Ms } | null = null;
  const flush = () => {
    if (run && run.start >= onset && run.end <= sleepEnd && (run.end - run.start) / MIN >= 2) awakenings++;
    run = null;
  };
  for (const s of segs) {
    if (s.stage !== 'awake') { flush(); continue; }
    if (run && s.start - run.end <= MIN) run.end = Math.max(run.end, s.end);
    else { flush(); run = { start: s.start, end: s.end }; }
  }
  flush();

  const hr = [...pn.hr].filter((h) => h.ts >= onset && h.ts <= sleepEnd && Number.isFinite(h.bpm)).sort((a, b) => a.ts - b.ts);
  const hrSm = hr.length ? rollingMedianTs(hr, (h: HrSample) => h.bpm, 2.5 * MIN) : [];
  let nadirIdx = -1;
  hrSm.forEach((v, i) => { if (nadirIdx < 0 || v < hrSm[nadirIdx]!) nadirIdx = i; });
  const hrAsleep = hr.filter((h) => inAny(h.ts, asleep)).map((h) => h.bpm);

  const hrv = pn.hrv.filter((h) => h.ts >= pn.sleep.start && h.ts <= pn.sleep.end).map((h) => h.rmssdMs);

  const spo2 = pn.spo2.filter((s) => s.ts >= onset && s.ts <= sleepEnd && Number.isFinite(s.pct)).sort((a, b) => a.ts - b.ts);
  const spo2Base = rollingMedianTs(spo2, (s) => s.pct, 15 * MIN);
  let dips = 0;
  let inDip = false;
  spo2.forEach((s, i) => {
    const dip = s.pct <= spo2Base[i]! - 3;
    if (dip && !inDip) dips++;
    inDip = dip;
  });

  const efficiencyPct = (100 * total) / inBedMin;
  const restorativeShare = total ? (byStage.deep + byStage.rem) / total : 0;
  const sleepParts = {
    duration: smoothScore(total, SLEEP_NEED_MIN, 240),
    efficiency: smoothScore(efficiencyPct, 92, 70),
    restorative: smoothScore(restorativeShare, 0.4, 0.15),
    awakenings: smoothScore(awakenings, 1, 10),
  };
  const W = SLEEP_SCORE_WEIGHTS;
  const sleepScore = 100 * (W.duration * sleepParts.duration + W.efficiency * sleepParts.efficiency + W.restorative * sleepParts.restorative + W.awakenings * sleepParts.awakenings);

  const m: PersonNightMetrics = {
    date,
    personId: pn.personId,
    totalSleepMin: Math.round(total),
    deepMin: Math.round(byStage.deep),
    remMin: Math.round(byStage.rem),
    lightMin: Math.round(byStage.light),
    awakeMin: Math.round(byStage.awake),
    efficiencyPct: r1(clamp(efficiencyPct, 0, 100)),
    latencyMin: Math.round((onset - pn.sleep.start) / MIN),
    awakenings,
    hrNadir: nadirIdx >= 0 ? r1(hrSm[nadirIdx]!) : NaN,
    hrNadirAtMin: nadirIdx >= 0 ? Math.round((hr[nadirIdx]!.ts - pn.sleep.start) / MIN) : NaN,
    hrMeanAsleep: r1(mean(hrAsleep)),
    rmssdMean: r1(mean(hrv)),
    spo2Mean: r1(mean(spo2.map((s) => s.pct))),
    spo2DipsPerHour: total > 0 ? Math.round((dips / (total / 60)) * 100) / 100 : 0,
    sleepScore: Math.round(sleepScore),
    recoveryScore: RECOVERY_NEUTRAL,
  };
  if (pn.respRate !== undefined) m.respRate = pn.respRate;
  if (pn.tempDeviationC !== undefined) m.tempDeviationC = pn.tempDeviationC;
  return { m, sleepParts };
}

/** Up to 30 earlier nights' base metrics for this person, newest first. */
export function personHistory(night: Night, personId: string, history: readonly Night[] = []): PersonNightMetrics[] {
  return history
    .filter((h) => h.date < night.date)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .map((h) => {
      const pn = h.people.find((p) => p.personId === personId);
      return pn ? baseMetrics(h.date, pn).m : null;
    })
    .filter((m): m is PersonNightMetrics => m !== null && m.totalSleepMin > 0)
    .slice(0, BASELINE_NIGHTS);
}

export function personNightBreakdown(night: Night, personId: string, history: readonly Night[] = []): { metrics: PersonNightMetrics; parts: PersonScoreParts } {
  const pn = night.people.find((p) => p.personId === personId);
  if (!pn) throw new Error(`personNightMetrics: no data for person '${personId}' on ${night.date}`);
  const { m, sleepParts } = baseMetrics(night.date, pn);
  const past = personHistory(night, personId, history);
  const parts: PersonScoreParts = { sleep: sleepParts, recovery: { hrvZ: null, hrZ: null, respDev: null, baselineNights: past.length, baseline: null } };
  if (past.length < MIN_BASELINE_NIGHTS) return { metrics: m, parts };

  const col = (f: (p: PersonNightMetrics) => number | undefined) => past.map(f).filter((v): v is number => v !== undefined && Number.isFinite(v));
  const band = (xs: number[], floor: number) => ({ m: mean(xs), s: Math.max(sd(xs) || 0, floor) });
  const rm = band(col((p) => p.rmssdMean), 2);
  rm.s = Math.max(rm.s, 0.08 * rm.m);
  const hrB = band(col((p) => p.hrNadir), 1.5);
  const rrB = band(col((p) => p.respRate), 0.3);
  parts.recovery.baseline = {
    rmssd: rm.m, hrNadir: hrB.m, respRate: rrB.m,
    deepMin: mean(col((p) => p.deepMin)), remMin: mean(col((p) => p.remMin)), totalSleepMin: mean(col((p) => p.totalSleepMin)),
  };

  // Recovery = Σ wᵢ·subᵢ over available inputs:
  //   hrv  = zSub((rmssd − μ)/σ)       higher HRV than usual is better
  //   hr   = zSub((μ − nadir)/σ)       lower nadir than usual is better
  //   sleep = tonight's sleepScore
  //   resp = 100·exp(−d²/4.5), d = |resp − μ|/σ   any deviation is a warning sign
  const comps: [number, number][] = [[RECOVERY_WEIGHTS.sleep, m.sleepScore]];
  if (Number.isFinite(m.rmssdMean) && Number.isFinite(rm.m)) {
    parts.recovery.hrvZ = (m.rmssdMean - rm.m) / rm.s;
    comps.push([RECOVERY_WEIGHTS.hrv, zSub(parts.recovery.hrvZ)]);
  }
  if (Number.isFinite(m.hrNadir) && Number.isFinite(hrB.m)) {
    parts.recovery.hrZ = (hrB.m - m.hrNadir) / hrB.s;
    comps.push([RECOVERY_WEIGHTS.hr, zSub(parts.recovery.hrZ)]);
  }
  if (m.respRate !== undefined && Number.isFinite(rrB.m)) {
    parts.recovery.respDev = Math.abs(m.respRate - rrB.m) / rrB.s;
    comps.push([RECOVERY_WEIGHTS.resp, 100 * Math.exp(-(parts.recovery.respDev ** 2) / 4.5)]);
  }
  const wSum = comps.reduce((a, [w]) => a + w, 0);
  m.recoveryScore = Math.round(clamp(comps.reduce((a, [w, v]) => a + w * v, 0) / wSum, 0, 100));
  return { metrics: m, parts };
}

/**
 * Per-person metrics for one night. hrNadir uses a 5-min rolling median; hrNadirAtMin is measured from
 * the sleep session start. Missing signals give NaN. recoveryScore needs ≥ 7 earlier nights in `history`
 * (30-night baseline), otherwise it is the neutral 70.
 */
export function personNightMetrics(night: Night, personId: string, history: Night[] = []): PersonNightMetrics {
  return personNightBreakdown(night, personId, history).metrics;
}
