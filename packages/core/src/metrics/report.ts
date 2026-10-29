import { targetAt } from '../curve.ts';
import type { Night, NightReport, ScoreDriver, TemperatureCurve } from '../types.ts';
import { lpsToPpmPerHour } from './co2.ts';
import { RECOVERY_WEIGHTS, personNightBreakdown } from './person.ts';
import { MIN_ROOM_COVERAGE, SLEEP_AIR_WEIGHTS, roomNightBreakdown } from './room.ts';
import { HOUR, MIN, fmtDuration, mean } from './util.ts';

/** Drivers are expressed against a typical sub-score of 70, so "+" means better than an ordinary night. */
const TYPICAL = 70;
const NEUTRAL_Z_SUB = 100 / (1 + Math.exp(-0.7));
const fmtPpm = (x: number) => Math.round(x).toLocaleString('en-US');
const pct = (x: number) => `${Math.round(x * 100)}%`;
const signed = (x: number, unit: string) => `${Math.abs(Math.round(x))} ${unit} ${x >= 0 ? 'above' : 'below'}`;

/** ACH needed to hold CO₂ ≤ 1000 ppm with two sleepers (0.0062 L/s) in 120 m³. */
const ACH_FOR_1000 = lpsToPpmPerHour(0.0062, 120) / (1000 - 425);

/** Deterministic report: metrics, signed score drivers, a headline and 2–4 plain-English insights. */
export function buildRuleReport(night: Night, history: Night[], curve: TemperatureCurve): NightReport {
  const { metrics: room, parts } = roomNightBreakdown(night, curve);
  const people = night.people.map((p) => personNightBreakdown(night, p.personId, history));
  const past = history.filter((h) => h.date < night.date).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 30);
  const pastRoom = past.filter((h) => h.room.length).map((h) => roomNightBreakdown(h, curve).metrics).filter((m) => Number.isFinite(m.sleepAirScore));
  const roomOk = parts.coverage >= MIN_ROOM_COVERAGE;

  const W = SLEEP_AIR_WEIGHTS;
  const pts = (w: number, sub: number) => Math.round(w * (100 * sub - TYPICAL));
  const nightMin = Math.max(1, parts.minutes);
  const drivers: ScoreDriver[] = !roomOk ? [] : [
    {
      label: room.minutesCo2Over1000 > 0 ? `CO₂ > 1000 for ${fmtDuration(room.minutesCo2Over1000)}` : `CO₂ stayed under 1000 (mean ${fmtPpm(room.co2Mean)} ppm)`,
      points: pts(W.co2, parts.co2),
    },
    {
      label: `On the temperature curve ${pct(room.minutesTempInTarget / nightMin)} of the night (first 4 h avg ${room.tempEarlyMean.toFixed(1)} °C)`,
      points: pts(W.temp, parts.temp),
    },
    {
      label: room.minutesRhOver60 >= 30 ? `Humidity > 60% for ${fmtDuration(room.minutesRhOver60)}` : `Humidity in 45–55% for ${pct(room.minutesRhInBand / nightMin)} of the night`,
      points: pts(W.rh, parts.rh),
    },
    {
      label: room.minutesTempOver24 > 0 ? `Room above 24 °C for ${fmtDuration(room.minutesTempOver24)}` : `Steady temperature (±${parts.tempSd.toFixed(1)} °C around the curve)`,
      points: pts(W.stability, parts.stability),
    },
  ];
  for (const { metrics: m, parts: p } of people) {
    const base = p.recovery.baseline;
    if (p.recovery.hrvZ !== null && base) {
      const d = (m.rmssdMean - base.rmssd) / base.rmssd;
      drivers.push({ label: `${m.personId}: HRV ${signed(d * 100, '%')} baseline`, points: Math.round(RECOVERY_WEIGHTS.hrv * (100 / (1 + Math.exp(-(1.2 * p.recovery.hrvZ + 0.7))) - NEUTRAL_Z_SUB)) });
    }
    if (p.recovery.hrZ !== null && base) {
      drivers.push({ label: `${m.personId}: HR nadir ${signed(m.hrNadir - base.hrNadir, 'bpm')} baseline`, points: Math.round(RECOVERY_WEIGHTS.hr * (100 / (1 + Math.exp(-(1.2 * p.recovery.hrZ + 0.7))) - NEUTRAL_Z_SUB)) });
    }
  }
  const ranked = drivers.filter((d) => d.points !== 0).sort((a, b) => Math.abs(b.points) - Math.abs(a.points));

  const worst = ranked.filter((d) => d.points <= -3).sort((a, b) => a.points - b.points)[0];
  const best = ranked.filter((d) => d.points >= 3).sort((a, b) => b.points - a.points)[0];
  const headline = !roomOk
    ? `Not enough room data: the meter covered ${pct(parts.coverage)} of the night`
    : worst
    ? `Sleep Air ${room.sleepAirScore}: ${lowerFirst(worst.label)} held it back`
    : best
      ? `Sleep Air ${room.sleepAirScore}: ${lowerFirst(best.label)}`
      : `Sleep Air ${room.sleepAirScore}: an ordinary night`;

  const insights: string[] = [];
  const co2Hist = mean(pastRoom.map((r) => r.co2Mean));
  if (!roomOk) {
    insights.push(`Room readings cover only ${pct(parts.coverage)} of lights-out → wake, so Sleep Air isn't scored. Check the meter's power and Wi-Fi.`);
  } else if (pastRoom.length >= 3 && Number.isFinite(co2Hist)) {
    const d = room.co2Mean - co2Hist;
    insights.push(
      Math.abs(d) < 25
        ? `Mean CO₂ was ${fmtPpm(room.co2Mean)} ppm, in line with your ${pastRoom.length}-night average (peak ${fmtPpm(room.co2Max)}).`
        : `Mean CO₂ was ${fmtPpm(room.co2Mean)} ppm, ${signed(d, 'ppm')} your ${pastRoom.length}-night average (peak ${fmtPpm(room.co2Max)}).`,
    );
  } else {
    insights.push(`Mean CO₂ was ${fmtPpm(room.co2Mean)} ppm with a peak of ${fmtPpm(room.co2Max)} ppm.`);
  }
  if (room.achMorning !== null) {
    insights.push(
      room.achMorning < ACH_FOR_1000
        ? `This morning's CO₂ decay shows ${room.achMorning.toFixed(2)} air changes per hour; about ${ACH_FOR_1000.toFixed(2)} is needed to keep two sleepers under 1000 ppm.`
        : `This morning's CO₂ decay shows ${room.achMorning.toFixed(2)} air changes per hour, enough to keep two sleepers near 1000 ppm.`,
    );
  }
  for (const { metrics: m, parts: p } of people) {
    const base = p.recovery.baseline;
    if (base && Number.isFinite(base.deepMin) && Math.abs(m.deepMin - base.deepMin) >= 10) {
      insights.push(`${m.personId}: deep sleep ${signed(m.deepMin - base.deepMin, 'min')} your ${p.recovery.baselineNights}-night average (${m.deepMin} vs ${Math.round(base.deepMin)} min).`);
    }
    if (Number.isFinite(m.hrNadirAtMin) && m.totalSleepMin > 0 && m.hrNadirAtMin > 0.6 * (m.totalSleepMin + m.latencyMin)) {
      const ctx = night.tags.filter((t) => t === 'alcohol' || t === 'late_meal' || t === 'late_exercise');
      insights.push(`${m.personId}: heart rate bottomed out late (${fmtDuration(m.hrNadirAtMin)} in)${ctx.length ? `, on a night tagged ${ctx.join(', ').replace(/_/g, ' ')}` : ''}; a late nadir often follows a warm room, late meals or alcohol.`);
    }
  }
  const early: number[] = [];
  for (let ts = night.lightsOut; ts < night.lightsOut + 4 * HOUR; ts += 10 * MIN) {
    const t = targetAt(curve, night.lightsOut, ts, night.sleepOnset);
    if (t !== null) early.push(t);
  }
  const earlyTarget = mean(early);
  if (roomOk && Number.isFinite(earlyTarget) && Number.isFinite(room.tempEarlyMean)) {
    const diff = room.tempEarlyMean - earlyTarget;
    insights.push(
      Math.abs(diff) <= 0.75
        ? `The first 4 h tracked the cool curve (avg ${room.tempEarlyMean.toFixed(1)} °C vs ${earlyTarget.toFixed(1)} °C target).`
        : `The first 4 h averaged ${room.tempEarlyMean.toFixed(1)} °C, ${Math.abs(diff).toFixed(1)} °C ${diff > 0 ? 'warmer' : 'cooler'} than the ${earlyTarget.toFixed(1)} °C target.`,
    );
  }

  return {
    date: night.date,
    room,
    people: people.map((p) => p.metrics),
    drivers: ranked,
    headline,
    insights: insights.slice(0, 4),
    generatedBy: 'rules',
  };
}

const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);
