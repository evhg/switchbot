import { afterAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_CURVE,
  DEFAULT_REMOTE,
  detectEvents,
  fitDecayAch,
  personNightMetrics,
  planAcSchedule,
  resolveQuiet,
  roomNightMetrics,
  simulateNights,
  withQuiet,
} from '../src/index.ts';
import type { Night, RoomEvent, RoomEventKind, TemperatureCurve } from '../src/types.ts';

// End-to-end: 60 simulated nights → detectors/metrics must recover the simulator's ground truth.
const NIGHTS = 60;
const MIN = 60_000;
const TOL = 15 * MIN;

const nights: Night[] = simulateNights({ nights: NIGHTS, seed: 2024, endDate: '2026-10-28' });
const detected = new Map<string, RoomEvent[]>(nights.map((n) => [n.date, detectEvents(n.room, { lightsOut: n.lightsOut, wake: n.wake })]));
const report: Record<string, string> = {};

const truthOf = (n: Night, kind: RoomEventKind) => n.truth!.events.filter((e) => e.kind === kind);
const detOf = (n: Night, kind: RoomEventKind) => detected.get(n.date)!.filter((e) => e.kind === kind);
const near = (a: RoomEvent, b: RoomEvent) => Math.abs(a.start - b.start) <= TOL;
const pct = (x: number) => `${Math.round(x * 100)}%`;

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
}

/** Truth events are recalled if any detection is within ±15 min (two people showering back to back count once each). */
function recallPrecision(kind: RoomEventKind, eligible: (n: Night, e: RoomEvent) => boolean = () => true) {
  let truthN = 0, recalled = 0, detN = 0, correct = 0;
  for (const n of nights) {
    const t = truthOf(n, kind);
    const d = detOf(n, kind);
    for (const e of t) if (eligible(n, e)) { truthN++; if (d.some((x) => near(x, e))) recalled++; }
    for (const x of d) { detN++; if (t.some((e) => near(x, e))) correct++; }
  }
  return { truthN, recall: recalled / truthN, detN, precision: detN ? correct / detN : 1 };
}

function expectWellSpaced(n: Night) {
  for (let i = 1; i < n.ac.length; i++) {
    const a = n.ac[i - 1]!;
    const b = n.ac[i]!;
    expect(b.ts - a.ts, `${n.date} interval`).toBeGreaterThanOrEqual(DEFAULT_REMOTE.minIntervalMin * MIN);
    // Same state twice in a row is only allowed as a deliberate resend of a command that didn't (visibly) land.
    if (JSON.stringify(a.state) === JSON.stringify(b.state)) {
      expect(a.landed, `${n.date} duplicate at ${i}`).not.toBe(true);
      expect(b.reason.startsWith('resend'), `${n.date} duplicate at ${i}`).toBe(true);
    }
  }
}

describe('integration: simulator truth → detectors and metrics', () => {
  afterAll(() => console.log(`\nintegration (${NIGHTS} nights, seed 2024)\n` + Object.entries(report).map(([k, v]) => `  ${k.padEnd(22)} ${v}`).join('\n')));

  it('fits the departure decay ACH within ±30% of truth', () => {
    let eligible = 0, ok = 0;
    for (const n of nights) {
      // Clean departure: the morning room_empty span after the final rise, ≥ 90 min, no door opening inside it.
      const empty = truthOf(n, 'room_empty').find((e) => e.start >= n.wake && (e.end ?? e.start) - e.start >= 90 * MIN);
      if (!empty) continue;
      const end = empty.end!;
      if (truthOf(n, 'door_open').some((d) => d.start <= end && (d.end ?? d.start) >= empty.start - 5 * MIN)) continue;
      const startCo2 = n.room.find((r) => r.ts >= empty.start)?.co2 ?? 0;
      if (startCo2 < 800) continue; // too little excess CO₂ for a meaningful decay
      eligible++;
      const fit = fitDecayAch(n.room.filter((r) => r.ts >= empty.start && r.ts <= end));
      if (fit && Math.abs(fit.ach - n.truth!.ach) <= 0.3 * n.truth!.ach) ok++;
    }
    report.achRecovery = `${ok}/${eligible} (${pct(ok / eligible)}) of clean departure decays within ±30%`;
    expect(eligible).toBeGreaterThanOrEqual(NIGHTS * 0.4);
    expect(ok / eligible).toBeGreaterThanOrEqual(0.7);
  });

  it('detects showers with ≥80% recall and ≥80% precision (±15 min)', () => {
    const r = recallPrecision('shower');
    report.shower = `recall ${pct(r.recall)} of ${r.truthN}, precision ${pct(r.precision)} of ${r.detN}`;
    expect(r.recall).toBeGreaterThanOrEqual(0.8);
    expect(r.precision).toBeGreaterThanOrEqual(0.8);
  });

  it('detects door openings that leave a CO₂ signature with ≥70% recall', () => {
    // A door can only drop CO₂ by part of the indoor excess; evening openings near outdoor level (~500 ppm) are invisible.
    const visible = (n: Night, e: RoomEvent) => (n.room.find((r) => r.ts >= e.start - 2 * MIN)?.co2 ?? 0) >= 800;
    const all = recallPrecision('door_open');
    const r = recallPrecision('door_open', visible);
    report.door_open = `recall ${pct(r.recall)} of ${r.truthN} visible (${pct(all.recall)} of all ${all.truthN}), precision ${pct(r.precision)}`;
    expect(r.truthN).toBeGreaterThanOrEqual(5);
    expect(r.recall).toBeGreaterThanOrEqual(0.7);
    expect(r.precision).toBeGreaterThanOrEqual(0.7);
  });

  it('places in_bed onset within ±30 min on ≥70% of nights', () => {
    let ok = 0;
    for (const n of nights) {
      const t = truthOf(n, 'in_bed')[0];
      const d = detOf(n, 'in_bed')[0];
      if (t && d && Math.abs(d.start - t.start) <= 30 * MIN) ok++;
    }
    report.in_bed = `${ok}/${NIGHTS} (${pct(ok / NIGHTS)}) within ±30 min`;
    expect(ok / NIGHTS).toBeGreaterThanOrEqual(0.7);
  });

  it('produces finite, in-range room and person metrics for every night', () => {
    nights.forEach((n, i) => {
      const m = roomNightMetrics(n, DEFAULT_CURVE);
      const sleepMin = (n.wake - n.lightsOut) / MIN;
      for (const [k, v] of Object.entries(m)) if (typeof v === 'number') expect(Number.isFinite(v), `${n.date} room.${k}`).toBe(true);
      expect(m.co2Mean).toBeGreaterThan(380);
      expect(m.co2Mean).toBeLessThanOrEqual(m.co2P95);
      expect(m.co2P95).toBeLessThanOrEqual(m.co2Max);
      expect(m.co2Max).toBeLessThan(5000);
      expect(m.tempMean).toBeGreaterThan(15);
      expect(m.tempMean).toBeLessThan(32);
      expect(m.rhMean).toBeGreaterThan(20);
      expect(m.rhMean).toBeLessThanOrEqual(100);
      for (const k of ['minutesCo2Over1000', 'minutesCo2Over1500', 'minutesTempInTarget', 'minutesTempOver24', 'minutesRhOver60', 'minutesRhInBand'] as const) {
        expect(m[k], `${n.date} ${k}`).toBeGreaterThanOrEqual(0);
        expect(m[k], `${n.date} ${k}`).toBeLessThanOrEqual(sleepMin + 1);
      }
      expect(m.sleepAirScore).toBeGreaterThanOrEqual(0);
      expect(m.sleepAirScore).toBeLessThanOrEqual(100);
      if (m.achMorning !== null) expect(m.achMorning).toBeGreaterThan(0);
      expect(m.acCommands).toBe(n.ac.length);

      for (const p of n.people) {
        const pm = personNightMetrics(n, p.personId, nights.slice(Math.max(0, i - 30), i));
        for (const k of ['totalSleepMin', 'deepMin', 'remMin', 'lightMin', 'awakeMin', 'efficiencyPct', 'latencyMin', 'awakenings', 'hrNadir', 'hrNadirAtMin', 'hrMeanAsleep', 'rmssdMean', 'spo2Mean', 'spo2DipsPerHour', 'sleepScore', 'recoveryScore'] as const) {
          expect(Number.isFinite(pm[k]), `${n.date} ${p.personId}.${k}`).toBe(true);
        }
        expect(pm.totalSleepMin).toBeGreaterThan(120);
        expect(pm.totalSleepMin).toBeLessThanOrEqual(12 * 60);
        expect(pm.deepMin + pm.remMin + pm.lightMin).toBeLessThanOrEqual(pm.totalSleepMin + 2);
        expect(pm.efficiencyPct).toBeGreaterThan(50);
        expect(pm.efficiencyPct).toBeLessThanOrEqual(100);
        expect(pm.hrNadir).toBeGreaterThan(30);
        expect(pm.hrNadir).toBeLessThanOrEqual(pm.hrMeanAsleep);
        expect(pm.spo2Mean).toBeGreaterThan(85);
        expect(pm.spo2Mean).toBeLessThanOrEqual(100);
        for (const s of [pm.sleepScore, pm.recoveryScore]) {
          expect(s).toBeGreaterThanOrEqual(0);
          expect(s).toBeLessThanOrEqual(100);
        }
      }
    });
  }, 60_000);

  const remoteGap = DEFAULT_REMOTE.minIntervalMin * MIN;
  it('quiet controller (steady default curve) logs 2–5 commands per night, nothing planned while asleep, and matches the plan', () => {
    const quiet = resolveQuiet(DEFAULT_REMOTE);
    const counts: number[] = [];
    const asleepCounts: number[] = [];
    for (const n of nights) {
      const from = n.lightsOut + quiet.settleMin * MIN;
      const asleep = n.ac.filter((c) => c.ts >= from && c.ts < n.wake);
      counts.push(n.ac.length);
      asleepCounts.push(asleep.length);
      expect(n.ac.length, n.date).toBeGreaterThanOrEqual(2);
      expect(n.ac.length, n.date).toBeLessThanOrEqual(5);
      // Hard bound by design: the steady curve plans NO command while asleep (whatever the expected sleep onset; a
      // re-measured bias never adds one); only the safety nets remain: one extra command (a resend or an emergency
      // that cools, shared budget) → at most 1 beep while asleep.
      expect(n.sleepOnset, n.date).toBeDefined();
      const plan = planAcSchedule({ curve: DEFAULT_CURVE, lightsOut: n.lightsOut, wake: n.wake, remote: DEFAULT_REMOTE, sleepOnset: n.sleepOnset! });
      expect(plan.asleepCount, n.date).toBe(0);
      expect(plan.commands.map((c) => c.kind), n.date).toEqual(['on', 'off']);
      const planned = asleep.filter((c) => c.reason.startsWith('curve:'));
      const extra = asleep.filter((c) => !c.reason.startsWith('curve:'));
      expect(planned, `${n.date} planned steps while asleep`).toEqual([]);
      expect(extra.length, `${n.date} extras while asleep`).toBeLessThanOrEqual(quiet.maxExtraPerNight);
      for (const c of extra) expect(c.reason, n.date).toMatch(/^(resend|emergency: room .* above)/);
      // An emergency only ever cools.
      for (const c of extra.filter((x) => x.reason.startsWith('emergency'))) {
        const before = n.ac.filter((x) => x.ts < c.ts && x.state.power).at(-1)!;
        expect(c.state.setpointC, n.date).toBeLessThan(before.state.setpointC);
      }
      // The page's plan and the controller agree, command by command:
      //  - the evening ON at the precool start (setpoint within 1 °C, the measured bias),
      const firstOn = n.ac.find((c) => c.state.power)!;
      expect(Math.abs(firstOn.ts - plan.commands[0]!.ts), `${n.date} precool start`).toBeLessThanOrEqual(5 * MIN);
      expect(Math.abs(firstOn.state.setpointC - plan.commands[0]!.state.setpointC), `${n.date} precool setpoint`).toBeLessThanOrEqual(1);
      //  - no planned command around lights-out (precool already holds the lights-out target, same fan),
      const settle = n.ac.filter((c) => c.ts >= n.lightsOut && c.ts < from);
      expect(settle.filter((c) => c.reason.startsWith('curve:')), `${n.date} lights-out`).toEqual([]);
      //  - the evening (precool → settle) adds only resends/corrections of the precool, never another planned step,
      const evening = n.ac.filter((c) => c.ts < from && c !== firstOn);
      for (const c of evening) expect(c.reason, `${n.date} evening`).toMatch(/^(resend|correction)/);
      //  - and OFF at wake + 30 min, as planned.
      expect(n.ac.at(-1)!.state.power, n.date).toBe(false);
      const off = n.ac.find((c) => !c.state.power)!; // the scheduled OFF (a resend of it may follow)
      expect(Math.abs(off.ts - plan.commands.at(-1)!.ts), `${n.date} OFF`).toBeLessThanOrEqual(5 * MIN);
      for (const c of n.ac) if (c.state.power) {
        expect(c.state.setpointC).toBeGreaterThanOrEqual(DEFAULT_CURVE.minC);
        expect(c.state.setpointC).toBeLessThanOrEqual(DEFAULT_CURVE.maxC);
      }
      expectWellSpaced(n);
    }
    counts.sort((a, b) => a - b);
    asleepCounts.sort((a, b) => a - b);
    report.acCommands = `min ${counts[0]}, median ${counts[counts.length >> 1]}, max ${counts[counts.length - 1]}`;
    report.acWhileAsleep = `min ${asleepCounts[0]}, median ${asleepCounts[asleepCounts.length >> 1]}, max ${asleepCounts[asleepCounts.length - 1]} (beeps)`;
    // No beep on a typical night, never more than the one safety net.
    expect(asleepCounts[asleepCounts.length >> 1]).toBe(0);
    expect(asleepCounts[asleepCounts.length - 1]).toBeLessThanOrEqual(1);
  });

  it('closed-loop controller (quiet off) still logs 2–16 commands per night, no duplicates, respecting minInterval', () => {
    const loud = simulateNights({ nights: 20, seed: 2024, endDate: '2026-10-28', remote: withQuiet(DEFAULT_REMOTE, false) });
    const counts: number[] = [];
    for (const n of loud) {
      counts.push(n.ac.length);
      expect(n.ac.length, n.date).toBeGreaterThanOrEqual(2);
      expect(n.ac.length, n.date).toBeLessThanOrEqual(Math.min(16, DEFAULT_REMOTE.maxCommandsPerNight));
      expectWellSpaced(n);
    }
    counts.sort((a, b) => a - b);
    report.acClosedLoop = `min ${counts[0]}, median ${counts[counts.length >> 1]}, max ${counts[counts.length - 1]} (quiet off)`;
  }, 60_000);

  it('recovers the environment → sleep effect across nights', () => {
    // Within one run the controller holds the room tightly to the curve, so night-to-night temperature
    // spread is ~0.3 °C and the weak correlation (simulated −7 min deep/°C, noise SD ≈ 11 min) is only reported.
    // The effect is asserted the way the Lab measures it: same nights, a warmer curve as the other arm.
    // The warm arm is +3 °C (was +2.5 until 2026-11-01). The cool arm cannot follow its 18.5 °C target on the
    // simulated nights whose bed sits 1.5–3 °C above the return air: its setpoint floors at 17 (SETALL_MIN_C, the
    // remote cannot encode 16) and the emergency no longer fires while the room is still cooling, so the cool arm runs
    // warmer than before (early mean 19.68 → 19.91 °C) while the warm arm is unchanged (21.26 → 21.30). With +2.5 the
    // achieved contrast fell to 1.40 °C; +3 restores ~2.1 °C, so `dTemp > 1.5` still checks what it is for: the two arms
    // really differ by more than 1.5 °C at bed height, enough for the min/°C slope below to mean something.
    const warm: TemperatureCurve = { ...DEFAULT_CURVE, id: 'warm', phases: DEFAULT_CURVE.phases.map((p) => ({ ...p, targetC: p.targetC + 3 })), maxC: DEFAULT_CURVE.maxC + 3 };
    const rows = (ns: Night[], curve: TemperatureCurve) =>
      ns.filter((n) => n.people.length).map((n) => {
        const m = roomNightMetrics(n, curve);
        const deep = n.people.map((p) => personNightMetrics(n, p.personId).deepMin);
        return { temp: m.tempEarlyMean, co2: m.co2Mean, deep: deep.reduce((a, b) => a + b, 0) / deep.length };
      });
    const base = rows(nights, DEFAULT_CURVE);
    const hot = rows(simulateNights({ nights: NIGHTS, seed: 2024, endDate: '2026-10-28', curve: warm }), warm);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const rT = pearson(base.map((r) => r.temp), base.map((r) => r.deep));
    const rC = pearson(base.map((r) => r.co2), base.map((r) => r.deep));
    const pooled = [...base, ...hot];
    const rPooled = pearson(pooled.map((r) => r.temp), pooled.map((r) => r.deep));
    const dTemp = mean(hot.map((r) => r.temp)) - mean(base.map((r) => r.temp));
    const dDeep = mean(hot.map((r) => r.deep)) - mean(base.map((r) => r.deep));
    const shallower = hot.filter((r, i) => r.deep < base[i]!.deep).length / hot.length;
    report.envEffect = `within-run r(tempEarly, deep) ${rT.toFixed(2)}, r(co2Mean, deep) ${rC.toFixed(2)}`;
    report.warmCurveArm = `+${dTemp.toFixed(1)} °C → ${dDeep.toFixed(1)} min deep (${(dDeep / dTemp).toFixed(1)} min/°C), ${pct(shallower)} nights shallower, pooled r ${rPooled.toFixed(2)}`;
    expect(dTemp).toBeGreaterThan(1.5);
    expect(dDeep / dTemp).toBeLessThan(-4);
    expect(dDeep / dTemp).toBeGreaterThan(-20);
    expect(shallower).toBeGreaterThanOrEqual(0.8);
    expect(rPooled).toBeLessThan(-0.5);
  }, 60_000);
});
