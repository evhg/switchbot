import { describe, expect, it } from 'vitest';
import { DEFAULT_CURVE, targetAt } from '../src/curve.ts';
import type { Night, PersonNight, RoomReading, SleepStage, StageSegment } from '../src/types.ts';
import { buildRuleReport, personNightMetrics, roomNightMetrics, SLEEP_AIR_WEIGHTS, RECOVERY_WEIGHTS, SLEEP_SCORE_WEIGHTS } from '../src/metrics/index.ts';

const MIN = 60_000;
const HOUR = 3_600_000;
const dayMs = 86_400_000;
/** 2026-10-28 wake date; 18:00 ICT the evening before. */
const EVENING = Date.UTC(2026, 9, 27, 11);
const LIGHTS_OUT = EVENING + 4 * HOUR; // 22:00 ICT
const WAKE = LIGHTS_OUT + 8 * HOUR; // 06:00 ICT

function room(offsetDays = 0, o: { co2?: (m: number) => number; temp?: (ts: number) => number; rh?: (m: number) => number } = {}): RoomReading[] {
  const out: RoomReading[] = [];
  const lo = LIGHTS_OUT + offsetDays * dayMs;
  for (let i = 0; i < 18 * 60; i++) {
    const ts = EVENING + offsetDays * dayMs + i * MIN;
    const m = (ts - lo) / MIN; // minutes since lights-out
    const morningDecay = m >= 480 ? 425 + 1175 * Math.exp((-0.3 * (m - 480)) / 60) : null;
    out.push({
      ts,
      co2: Math.round(morningDecay ?? o.co2?.(m) ?? (m < 0 ? 450 : m < 240 ? 900 : m < 360 ? 1100 : 1600)),
      tempC: o.temp?.(ts) ?? targetAt(DEFAULT_CURVE, lo, ts) ?? 23,
      rh: o.rh?.(m) ?? (m < 300 ? 50 : 62),
      source: 'sim',
    });
  }
  return out;
}

function stages(start: number, spec: [SleepStage, number][]): StageSegment[] {
  const out: StageSegment[] = [];
  let t = start;
  for (const [stage, min] of spec) {
    out.push({ stage, start: t, end: t + min * MIN });
    t += min * MIN;
  }
  return out;
}

function person(offsetDays = 0, o: { deep?: number; rmssd?: number; nadir?: number; resp?: number } = {}): PersonNight {
  const start = LIGHTS_OUT + offsetDays * dayMs;
  const deep = o.deep ?? 60;
  const segs = stages(start, [
    ['awake', 15], ['light', 45], ['deep', deep], ['awake', 5], ['light', 175 - deep], ['rem', 30],
    ['awake', 1], ['light', 89], ['deep', 30], ['rem', 90], ['awake', 30],
  ]);
  const end = segs[segs.length - 1]!.end;
  const nadir = o.nadir ?? 50;
  const hr = [];
  for (let ts = start; ts <= end; ts += MIN) {
    const m = (ts - start) / MIN;
    let bpm = 60;
    if (m >= 300 && m < 310) bpm = nadir; // true nadir 05:00 after start
    if (m === 180) bpm = 38; // single-sample artifact
    hr.push({ ts, bpm });
  }
  const spo2 = [];
  for (let ts = start; ts <= end; ts += MIN) {
    const m = (ts - start) / MIN;
    const dip = [100, 101, 200, 201, 350].includes(m);
    spo2.push({ ts, pct: dip ? 92 : 96 });
  }
  const hrv = [];
  for (let ts = start; ts < end; ts += 5 * MIN) hrv.push({ ts, rmssdMs: o.rmssd ?? 40 });
  return { personId: 'a', sleep: { personId: 'a', start, end, stages: segs }, hr, hrv, spo2, respRate: o.resp ?? 14.5, tempDeviationC: -0.2 };
}

function night(offsetDays = 0, extra: Partial<Night> = {}, p: Parameters<typeof person>[1] = {}): Night {
  const d = new Date(Date.UTC(2026, 9, 28) + offsetDays * dayMs).toISOString().slice(0, 10);
  return {
    date: d,
    lightsOut: LIGHTS_OUT + offsetDays * dayMs,
    wake: WAKE + offsetDays * dayMs,
    room: room(offsetDays),
    outdoor: [],
    ac: [],
    curveId: DEFAULT_CURVE.id,
    events: [],
    people: [person(offsetDays, p)],
    tags: [],
    ...extra,
  };
}

const history = (n: number) => Array.from({ length: n }, (_, k) => night(-(k + 1), {}, { deep: 50, rmssd: 38 + (k % 5), nadir: 52 + (k % 3) }));

describe('roomNightMetrics', () => {
  const m = roomNightMetrics(night(), DEFAULT_CURVE);

  it('counts minutes over CO₂ thresholds on lights-out → wake', () => {
    expect(m.minutesCo2Over1000).toBe(240);
    expect(m.minutesCo2Over1500).toBe(120);
    expect(m.co2Max).toBe(1600);
    expect(m.co2Mean).toBe(Math.round((900 * 240 + 1100 * 120 + 1600 * 120) / 480));
    expect(m.co2P95).toBe(1600);
  });

  it('measures temperature adherence and humidity bands', () => {
    expect(m.minutesTempInTarget).toBe(480);
    expect(m.minutesTempOver24).toBe(0);
    expect(m.minutesRhInBand).toBe(300);
    expect(m.minutesRhOver60).toBe(180);
    // The default curve holds 18.5 °C all night (steady-18-5-v1).
    expect(m.tempEarlyMean).toBeLessThan(19);
    expect(m.tempEarlyMean).toBeGreaterThanOrEqual(18.4);
  });

  it('fits the morning decay ACH', () => {
    expect(m.achMorning).not.toBeNull();
    expect(m.achMorning!).toBeCloseTo(0.3, 1);
  });

  it('scores a better room higher', () => {
    const good = night(0, { room: room(0, { co2: () => 700, rh: () => 50 }) });
    const hot = night(0, { room: room(0, { temp: () => 25.5 }) });
    const g = roomNightMetrics(good, DEFAULT_CURVE).sleepAirScore;
    expect(g).toBeGreaterThan(m.sleepAirScore);
    expect(g).toBeGreaterThanOrEqual(95);
    expect(roomNightMetrics(hot, DEFAULT_CURVE).sleepAirScore).toBeLessThan(m.sleepAirScore);
    expect(m.sleepAirScore).toBeGreaterThan(0);
    expect(m.sleepAirScore).toBeLessThan(100);
  });

  it('ignores impossible CO₂ (the 0 ppm warm-up artifact) but keeps that minute’s temperature', () => {
    const n = night();
    const glitched = n.room.map((r, i) => (i < 10 ? { ...r, co2: 0 } : r));
    const g = roomNightMetrics({ ...n, room: glitched }, DEFAULT_CURVE);
    expect(g.co2Max).toBe(1600);
    expect(g.co2Mean).toBeGreaterThanOrEqual(m.co2Mean);
    expect(g.co2Mean).toBeLessThan(m.co2Mean + 10);
    expect(g.minutesTempInTarget).toBe(m.minutesTempInTarget);
  });

  it('weights sum to 1', () => {
    for (const w of [SLEEP_AIR_WEIGHTS, SLEEP_SCORE_WEIGHTS, RECOVERY_WEIGHTS]) {
      expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    }
  });

  it('tolerates an empty room series', () => {
    const e = roomNightMetrics(night(0, { room: [] }), DEFAULT_CURVE);
    expect(e.sleepAirScore).toBeNaN();
    expect(e.co2Mean).toBeNaN();
    expect(e.achMorning).toBeNull();
  });

  it('reports insufficient data instead of a score when the meter dropped out overnight', () => {
    const n = night(0);
    const evening = { ...n, room: n.room.filter((r) => r.ts < n.lightsOut + 60 * 60_000) };
    const rep = buildRuleReport(evening, [], DEFAULT_CURVE);
    expect(rep.room.sleepAirScore).toBeNaN();
    expect(rep.headline).toMatch(/^Not enough room data/);
    expect(rep.drivers.every((d) => !/CO₂|temperature|Humidity/.test(d.label))).toBe(true);
  });
});

describe('personNightMetrics', () => {
  const m = personNightMetrics(night(), 'a');

  it('sums stages and derives efficiency, latency and awakenings', () => {
    expect(m.deepMin).toBe(90);
    expect(m.remMin).toBe(120);
    expect(m.lightMin).toBe(45 + 115 + 89);
    expect(m.awakeMin).toBe(51);
    expect(m.totalSleepMin).toBe(459);
    expect(m.efficiencyPct).toBeCloseTo((100 * 459) / 510, 1);
    expect(m.latencyMin).toBe(15);
    expect(m.awakenings).toBe(1); // 5-min wake counts; 1-min blip and final wake do not
  });

  it('finds the HR nadir with a rolling median, ignoring a 1-sample artifact', () => {
    expect(m.hrNadir).toBe(50);
    expect(m.hrNadirAtMin).toBeGreaterThanOrEqual(300);
    expect(m.hrNadirAtMin).toBeLessThanOrEqual(310);
    expect(m.hrMeanAsleep).toBeGreaterThan(59);
    expect(m.hrMeanAsleep).toBeLessThan(60.1);
  });

  it('computes HRV, SpO₂ dips and passes through resp/temp', () => {
    expect(m.rmssdMean).toBe(40);
    expect(m.spo2Mean).toBeCloseTo(96, 0);
    expect(m.spo2DipsPerHour).toBeCloseTo(3 / (459 / 60), 2);
    expect(m.respRate).toBe(14.5);
    expect(m.tempDeviationC).toBe(-0.2);
  });

  it('gives a high sleep score for a full, efficient night and less for a short one', () => {
    expect(m.sleepScore).toBeGreaterThan(80);
    const short = night(0, {}, {});
    short.people[0]!.sleep.stages = short.people[0]!.sleep.stages.slice(0, 4);
    short.people[0]!.sleep.end = short.people[0]!.sleep.stages[3]!.end;
    expect(personNightMetrics(short, 'a').sleepScore).toBeLessThan(m.sleepScore - 20);
  });

  it('is neutral 70 without enough history', () => {
    expect(m.recoveryScore).toBe(70);
    expect(personNightMetrics(night(), 'a', history(5)).recoveryScore).toBe(70);
  });

  it('rises with HRV above baseline and falls with HR above baseline', () => {
    const h = history(20);
    const good = personNightMetrics(night(0, {}, { rmssd: 50, nadir: 48 }), 'a', h).recoveryScore;
    const bad = personNightMetrics(night(0, {}, { rmssd: 28, nadir: 58, resp: 16.5 }), 'a', h).recoveryScore;
    expect(good).toBeGreaterThan(75);
    expect(bad).toBeLessThan(45);
  });

  it('ignores future nights in history', () => {
    const future = Array.from({ length: 10 }, (_, k) => night(k + 1, {}, { rmssd: 90 }));
    expect(personNightMetrics(night(), 'a', future).recoveryScore).toBe(70);
  });

  it('throws for an unknown person', () => {
    expect(() => personNightMetrics(night(), 'zz')).toThrow();
  });
});

describe('buildRuleReport', () => {
  const r = buildRuleReport(night(0, { tags: ['late_meal'] }, { deep: 80 }), history(20), DEFAULT_CURVE);

  it('assembles metrics and signed drivers', () => {
    expect(r.generatedBy).toBe('rules');
    expect(r.date).toBe('2026-10-28');
    expect(r.people).toHaveLength(1);
    const co2 = r.drivers.find((d) => d.label.startsWith('CO₂ > 1000'))!;
    expect(co2.label).toBe('CO₂ > 1000 for 4 h 0 m');
    expect(co2.points).toBeLessThan(0);
    for (let i = 1; i < r.drivers.length; i++) expect(Math.abs(r.drivers[i]!.points)).toBeLessThanOrEqual(Math.abs(r.drivers[i - 1]!.points));
  });

  it('writes a headline and 2–4 insights comparing against history', () => {
    expect(r.headline).toMatch(/^Sleep Air \d+/);
    expect(r.insights.length).toBeGreaterThanOrEqual(2);
    expect(r.insights.length).toBeLessThanOrEqual(4);
    expect(r.insights.some((s) => /deep sleep 30 min above your 20-night average/.test(s))).toBe(true);
    expect(r.insights.join(' ')).toMatch(/air changes per hour/);
  });

  it('works without history', () => {
    const r0 = buildRuleReport(night(), [], DEFAULT_CURVE);
    expect(r0.insights.length).toBeGreaterThanOrEqual(2);
    expect(r0.people[0]!.recoveryScore).toBe(70);
  });
});
