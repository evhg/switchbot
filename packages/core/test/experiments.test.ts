import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  analyzeExperiment,
  assignArm,
  AUTOPILOT_CANDIDATES,
  autopilotExperiment,
  autopilotStep,
  BUILTIN_CURVES,
  COOL_EARLY_WARM_LATE_V1,
  DEFAULT_CURVE,
  DEFAULT_REMOTE,
  EXPERIMENT_CURVES,
  EXPERIMENT_TEMPLATES,
  experimentLine,
  nextCandidate,
  nightOutcomes,
  personOutcomes,
  planAcSchedule,
  simulateNights,
  sleepScores,
  STEADY_19_5_QUIET_V1,
  tCdf,
  tQuantile,
  WARM_LATE_19_5_QUIET_V1,
  welchPosterior,
  withQuiet,
  type Experiment,
  type ExperimentNight,
  type NightOutcomes,
  type StageSegment,
} from '../src/index.ts';

const MIN = 60_000;
const LO = Date.parse('2026-11-04T22:00:00+07:00');
const WAKE = Date.parse('2026-11-05T08:30:00+07:00');
const at = (m: number) => LO + m * MIN;

describe('stats', () => {
  it('Student t CDF and quantile', () => {
    expect(tCdf(0, 5)).toBeCloseTo(0.5, 10);
    expect(tCdf(2.228, 10)).toBeCloseTo(0.975, 3);
    expect(tQuantile(0.95, 10)).toBeCloseTo(1.812, 3);
    expect(tQuantile(0.95, 1e6)).toBeCloseTo(1.645, 2);
  });

  it('Welch posterior: difference, 90 % interval and P(b > a)', () => {
    const p = welchPosterior([10, 12, 11, 13], [14, 15, 16, 15])!;
    expect(p.diff).toBeCloseTo(3.5, 10);
    expect(p.lo).toBeLessThan(3.5);
    expect(p.hi).toBeGreaterThan(3.5);
    expect(p.pPositive).toBeGreaterThan(0.99);
    expect(welchPosterior([1], [2, 3])).toBeNull();
    expect(welchPosterior([1, 1], [1, 1])!.pPositive).toBe(0.5);
    expect(welchPosterior([1, 1], [2, 2])!.pPositive).toBe(1);
  });
});

describe('night outcomes', () => {
  const seg = (a: number, b: number, stage: StageSegment['stage']): StageSegment => ({ start: at(a), end: at(b), stage });
  const stages: StageSegment[] = [
    seg(0, 20, 'awake'),
    seg(20, 60, 'light'),
    seg(60, 120, 'deep'),
    seg(120, 121, 'awake'), // 1 min: not an awakening
    seg(121, 200, 'light'),
    seg(200, 203, 'awake'), // awakening
    seg(203, 205, 'awake'), // same run
    seg(205, 300, 'rem'),
    seg(300, 310, 'awake'), // awakening
    seg(310, 600, 'light'),
    seg(600, 640, 'awake'), // after the last sleep stage: not counted
  ];

  it('per person: onset latency, stage minutes, awakenings ≥ 2 min after onset', () => {
    const p = personOutcomes(stages, LO)!;
    expect(p.onsetMin).toBe(20);
    expect(p.deepMin).toBe(60);
    expect(p.remMin).toBe(95);
    expect(p.awakeMin).toBe(1 + 5 + 10);
    expect(p.awakenings).toBe(2);
    expect(personOutcomes([seg(0, 30, 'awake')], LO)).toBeNull();
    // Asleep before lights-out → latency 0.
    expect(personOutcomes([seg(-10, 50, 'light')], LO)!.onsetMin).toBe(0);
  });

  it('room: CO₂ mean, minutes over 1000 ppm, mean temp; snoring minutes; what is missing', () => {
    const room = Array.from({ length: 631 }, (_, m) => ({ ts: at(m), co2: m < 120 ? 1100 : 800, tempC: 19 }));
    const sound = Array.from({ length: 60 }, (_, m) => ({ ts: at(m), snoreS: m < 15 ? 20 : 3 }));
    const o = nightOutcomes({ lightsOut: LO, wake: WAKE, sleep: { a: stages, b: null }, room, sound });
    expect(o.co2Over1000Min).toBe(120);
    expect(o.co2Mean).toBe(Math.round((120 * 1100 + 511 * 800) / 631));
    expect(o.tempMean).toBe(19);
    expect(o.snoreMin).toBe(15);
    expect(Object.keys(o.people)).toEqual(['a']);
    expect(o.missing).toEqual(['sleep:b']);
    const empty = nightOutcomes({ lightsOut: LO, wake: WAKE, sleep: { a: [] }, room: [], sound: null });
    expect(empty.co2Mean).toBeNull();
    expect(empty.missing).toEqual(['sleep:a', 'room', 'sound']);
  });
});

const door = EXPERIMENT_TEMPLATES.find((t) => t.slug === 'door-open-vs-closed')!;
const doorExp: Experiment = { slug: door.slug, title: door.title, kind: 'manual', arms: door.arms, primaryOutcome: door.primaryOutcome, status: 'running', startedOn: '2026-11-05', seed: 12345 };
const day = (i: number) => new Date(Date.parse('2026-11-05T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10);

function outcomes(o: { co2: number; deep: number; awakenings: number; awake?: number }): NightOutcomes {
  const person = { onsetMin: 20, deepMin: o.deep, remMin: 90, lightMin: 250, awakeMin: o.awake ?? 20, awakenings: o.awakenings };
  return { people: { a: person, b: { ...person } }, co2Mean: o.co2, co2Over1000Min: Math.max(0, o.co2 - 900), tempMean: 19, snoreMin: 10, missing: [] };
}

describe('assignment: balanced blocks, reproducible', () => {
  function run(exp: Experiment, n: number, exclude: (i: number) => boolean = () => false): ExperimentNight[] {
    const nights: ExperimentNight[] = [];
    for (let i = 0; i < n; i++) {
      const armKey = assignArm(exp, nights, day(i));
      nights.push({ nightDate: day(i), armKey, source: 'random', followed: !exclude(i), outcomes: outcomes({ co2: 900, deep: 60, awakenings: 2 }) });
    }
    return nights;
  }

  it('every block of 2 counted nights has both arms; same seed → same sequence', () => {
    const a = run(doorExp, 12);
    for (let b = 0; b < 6; b++) expect(new Set([a[2 * b]!.armKey, a[2 * b + 1]!.armKey]).size).toBe(2);
    expect(run(doorExp, 12).map((n) => n.armKey)).toEqual(a.map((n) => n.armKey));
    const other = run({ ...doorExp, seed: 999 }, 12).map((n) => n.armKey);
    expect(other.join()).not.toBe(a.map((n) => n.armKey).join());
  });

  it('a night that does not count repeats its slot; 3 arms in blocks of 3', () => {
    const skip = run(doorExp, 9, (i) => i === 2);
    expect(skip[3]!.armKey).toBe(skip[2]!.armKey);
    const counted = skip.filter((n) => n.followed);
    for (let b = 0; b < 4; b++) expect(new Set([counted[2 * b]!.armKey, counted[2 * b + 1]!.armKey]).size).toBe(2);
    const three: Experiment = { ...doorExp, arms: [...doorExp.arms, { key: 'wide', label: 'Door wide open', instruction: 'Door WIDE open' }] };
    const t = run(three, 9);
    for (let b = 0; b < 3; b++) expect(new Set(t.slice(3 * b, 3 * b + 3).map((n) => n.armKey)).size).toBe(3);
  });

  it('a night still waiting for its sleep sync keeps its slot (no same-arm pair when it fills in)', () => {
    const noSleep = { ...outcomes({ co2: 900, deep: 60, awakenings: 2 }), people: {}, missing: ['sleep:a', 'sleep:b'] };
    const first = assignArm(doorExp, [], day(0));
    const nights: ExperimentNight[] = [{ nightDate: day(0), armKey: first, source: 'random', followed: true, outcomes: noSleep }];
    // Evening of day(0): the night of day(0) was computed before the sleep sync; it is still pending.
    const second = assignArm(doorExp, nights, day(1));
    expect(second).not.toBe(first);
    // Long after, with the data still missing, it no longer counts: its slot is repeated.
    const later = [...nights, { nightDate: day(1), armKey: second, source: 'random' as const, followed: false, outcomes: null }];
    expect(assignArm(doorExp, later, day(5))).toBe(assignArm(doorExp, [], day(5)));
  });

  it('a pinned night takes its place in the block', () => {
    const pinned: ExperimentNight[] = [{ nightDate: day(0), armKey: 'open', source: 'pinned', followed: true, outcomes: null }];
    expect(assignArm(doorExp, pinned, day(1))).toBe('closed');
    pinned.push({ nightDate: day(1), armKey: 'open', source: 'pinned', followed: true, outcomes: null });
    // Two pinned 'open' nights: the next block starts; whichever arm the shuffle gives, after it the totals even out.
    const next = assignArm(doorExp, pinned, day(2));
    pinned.push({ nightDate: day(2), armKey: next, source: 'random', followed: true, outcomes: null });
    const after = assignArm(doorExp, pinned, day(3));
    expect(new Set([next, after]).size).toBe(2);
  });
});

describe('analysis and verdict', () => {
  // Door open: CO₂ ~180 ppm lower, deep sleep a bit higher, fewer awakenings.
  const co2 = { closed: [1150, 1180, 1120, 1200, 1160, 1170], open: [980, 990, 960, 1010, 970, 1000] };
  const deep = { closed: [55, 60, 50, 58, 62, 52], open: [64, 70, 60, 66, 72, 61] };
  const aw = { closed: [4, 5, 3, 4, 5, 4], open: [3, 3, 2, 4, 3, 2] };
  const nights: ExperimentNight[] = [];
  for (let i = 0; i < 6; i++) {
    for (const arm of ['closed', 'open'] as const) {
      nights.push({ nightDate: day(nights.length), armKey: arm, source: 'random', followed: true, outcomes: outcomes({ co2: co2[arm][i]!, deep: deep[arm][i]!, awakenings: aw[arm][i]! }) });
    }
  }

  it('per outcome: means, difference, 90 % interval, P(better); clear winner on the primary', () => {
    const a = analyzeExperiment(doorExp, nights);
    expect(a.counts).toEqual({ closed: 6, open: 6 });
    const c = a.perOutcome.find((o) => o.key === 'co2_mean')!;
    expect(c.arms.closed!.mean).toBeCloseTo(1163.3, 1);
    expect(c.diff).toBeCloseTo(985 - 1163.33, 1);
    expect(c.lo!).toBeLessThan(c.diff!);
    expect(c.hi!).toBeGreaterThan(c.diff!);
    expect(c.hi!).toBeLessThan(0);
    expect(c.pBetter!).toBeGreaterThan(0.99);
    expect(c.better).toBe('lower');
    expect(a.perOutcome.find((o) => o.key === 'a_awakenings')!.pBetter!).toBeGreaterThan(0.9);
    expect(a.primary!.key).toBe('sleep_score');
    expect(a.status).toBe('clear_winner');
    expect(a.winner).toBe('open');
    expect(a.verdict).toMatch(/^Door open a crack: Sleep score [\d.]+ higher \(90 %: [\d.]+–[\d.]+\)/);
    expect(a.verdict).toContain('CO₂ 178 ppm lower');
    expect(a.verdict).toMatch(/clearly better \(P=[\d.]+\)\. 6 vs 6 nights\.$/);
  });

  it('an interval that crosses zero reads "−a to b" with a true minus', () => {
    const co2x = { closed: [1000, 1100, 900, 1050, 980], open: [1010, 1090, 920, 1040, 1000] };
    const mixed: ExperimentNight[] = [];
    for (let i = 0; i < 5; i++) {
      for (const arm of ['closed', 'open'] as const) mixed.push({ nightDate: day(mixed.length), armKey: arm, source: 'random', followed: true, outcomes: outcomes({ co2: co2x[arm][i]!, deep: 60, awakenings: 3 }) });
    }
    const c = analyzeExperiment(doorExp, mixed).perOutcome.find((o) => o.key === 'co2_mean')!;
    expect(c.lo!).toBeLessThan(0);
    expect(c.hi!).toBeGreaterThan(0);
    expect(c.text).toMatch(/^CO₂ \d+ ppm (higher|lower) \(90 %: −\d+ to \d+\)$/);
    expect(c.text).not.toContain('-');
  });

  it('running until every arm has 4 counted nights; not-followed and missing nights do not count', () => {
    const few = nights.slice(0, 6);
    const a = analyzeExperiment(doorExp, few);
    expect(a.status).toBe('running');
    expect(a.verdict).toMatch(/^Too early: 3 vs 3 nights so far, 4 each needed\./);
    const marked = nights.map((n, i) => (i < 4 ? { ...n, followed: false } : n));
    expect(analyzeExperiment(doorExp, marked).counted).toBe(8);
    expect(analyzeExperiment(doorExp, marked).excluded).toBe(4);
    const noSleep = nights.map((n, i) => (i === 0 ? { ...n, outcomes: { ...n.outcomes!, people: {} } } : n));
    expect(analyzeExperiment(doorExp, noSleep).counts.closed).toBe(5);
  });

  it('no difference / done after the maximum nights', () => {
    const same: ExperimentNight[] = Array.from({ length: 22 }, (_, i) => ({
      nightDate: day(i),
      armKey: i % 2 ? 'open' : 'closed',
      source: 'random',
      followed: true,
      outcomes: outcomes({ co2: 1000 + ((i * 37) % 50), deep: 60 + ((i * 13) % 9), awakenings: 2 + (i % 3) }),
    }));
    const a = analyzeExperiment(doorExp, same);
    expect(a.done).toBe(true);
    expect(['no_difference', 'leaning']).toContain(a.status);
  });

  it('sleep score: mean of z-scores, 0 for an average night, deep/REM up and awake/awakenings down', () => {
    const s = sleepScores(nights);
    const vals = [...s.values()].map((r) => r.a!);
    expect(vals.reduce((x, y) => x + y, 0) / vals.length).toBeCloseTo(0, 2);
    const best = nights.reduce((b, n) => (s.get(n.nightDate)!.a! > s.get(b.nightDate)!.a! ? n : b));
    expect(best.armKey).toBe('open');
  });

  it('experimentLine: "Experiment: door OPEN a crack (night 1 of ≥8)"', () => {
    const tonight: ExperimentNight[] = [{ nightDate: '2026-11-05', armKey: 'open', source: 'pinned', followed: true, outcomes: null }];
    expect(experimentLine(doorExp, tonight, '2026-11-05')).toBe('Experiment: door OPEN a crack (night 1 of ≥8)');
    expect(experimentLine(doorExp, tonight, '2026-11-06')).toBeNull();
  });
});

describe('templates', () => {
  it('five templates; door open vs closed tags the open nights; aircon arms are known curves', () => {
    expect(EXPERIMENT_TEMPLATES).toHaveLength(5);
    expect(door.arms.map((a) => [a.key, a.instruction, a.tag])).toEqual([['closed', 'Door CLOSED', undefined], ['open', 'Door OPEN a crack', 'door_ajar']]);
    for (const t of EXPERIMENT_TEMPLATES) {
      expect(t.arms.length).toBeGreaterThanOrEqual(2);
      if (t.kind === 'auto') for (const a of t.arms) expect(BUILTIN_CURVES.some((c) => c.id === a.curve_id)).toBe(true);
      else for (const a of t.arms) expect(a.instruction).toBeTruthy();
    }
  });
});

describe('experiment curve variants pass the controller safety rules', () => {
  const remotes = [DEFAULT_REMOTE, withQuiet(DEFAULT_REMOTE, false)];

  it('mirror the default shape: minC 17, every phase from lights-out, fan auto → low at +30', () => {
    expect(EXPERIMENT_CURVES.map((c) => c.id)).toEqual(['warm-late-19-5-quiet-v1', 'steady-19-5-quiet-v1', 'cool-early-warm-late-v1']);
    expect(AUTOPILOT_CANDIDATES).toEqual([...EXPERIMENT_CURVES.map((c) => c.id), DEFAULT_CURVE.id]);
    for (const c of EXPERIMENT_CURVES) {
      expect(c.minC).toBe(17);
      expect(c.phases.map((p) => [p.name, p.fan])).toEqual(DEFAULT_CURVE.phases.map((p) => [p.name, p.fan]));
      expect(c.phases.every((p) => p.anchor === undefined && !p.ramp)).toBe(true);
      for (const p of c.phases) expect(p.targetC).toBeGreaterThanOrEqual(17);
      // The target never rises before lights-out + 300 (03:00): nothing warms during the deep-sleep window.
      for (let i = 1; i < c.phases.length; i++) {
        if (c.phases[i]!.targetC > c.phases[i - 1]!.targetC) expect(c.phases[i]!.startMin).toBeGreaterThanOrEqual(300);
        expect(c.phases[i]!.targetC).toBeGreaterThanOrEqual(c.phases[i - 1]!.targetC); // never colder later either
      }
    }
  });

  it('plans: setpoint ≥ 17, at most one step more while asleep than the default, the warming step at 03:00', () => {
    for (const biasC of [-1, -2]) {
      const def = planAcSchedule({ curve: DEFAULT_CURVE, lightsOut: LO, wake: WAKE, remote: DEFAULT_REMOTE, biasC });
      for (const curve of EXPERIMENT_CURVES) {
        const plan = planAcSchedule({ curve, lightsOut: LO, wake: WAKE, remote: DEFAULT_REMOTE, biasC });
        for (const c of plan.commands) if (c.state.power) expect(c.state.setpointC).toBeGreaterThanOrEqual(17);
        expect(plan.asleepCount).toBeLessThanOrEqual(def.asleepCount + 1);
        const asleep = plan.commands.filter((c) => c.asleep && c.state.power);
        let prev = plan.commands.filter((c) => !c.asleep && c.state.power).at(-1)!.state.setpointC;
        for (const c of asleep) {
          if (c.state.setpointC > prev) expect((c.ts - LO) / MIN).toBeGreaterThanOrEqual(300);
          prev = c.state.setpointC;
        }
      }
    }
    // With bias −2: 18.5 / 18 → the 17 floor, 19.5 → 18.
    const sp = (curve: typeof DEFAULT_CURVE) => planAcSchedule({ curve, lightsOut: LO, wake: WAKE, remote: DEFAULT_REMOTE, biasC: -2 }).commands.filter((c) => c.state.power).map((c) => c.state.setpointC);
    expect(new Set(sp(STEADY_19_5_QUIET_V1))).toEqual(new Set([18]));
    expect(sp(WARM_LATE_19_5_QUIET_V1)).toEqual([17, 17, 18]);
    expect(sp(COOL_EARLY_WARM_LATE_V1)).toEqual([17, 17, 18]);
  });

  it('controller on simulated nights: never below 17, emergencies never warm, warming only as the planned 03:00 step', () => {
    for (const curve of EXPERIMENT_CURVES) {
      for (const remote of remotes) {
        const nights = simulateNights({ nights: 10, seed: 77, endDate: '2026-11-03', curve, remote });
        for (const n of nights) {
          let prev: number | null = null;
          for (const c of n.ac) {
            if (!c.state.power) continue;
            expect(c.state.setpointC, `${curve.id} ${n.date} ${c.reason}`).toBeGreaterThanOrEqual(17);
            const asleep = c.ts >= n.lightsOut + 15 * MIN && c.ts < n.wake;
            // Quiet mode (the default, live) never warms while asleep except by the planned step. With quiet mode off the
            // closed loop may correct a too-cold room by +1, for every curve alike (existing controller behaviour).
            if (remote === DEFAULT_REMOTE && asleep && prev !== null && c.state.setpointC > prev) {
              expect(c.reason, `${curve.id} ${n.date}`).toMatch(/^curve: (middle|late)/);
              expect((c.ts - n.lightsOut) / MIN).toBeGreaterThanOrEqual(300);
            }
            if (c.reason.startsWith('emergency') && prev !== null) expect(c.state.setpointC).toBeLessThan(prev);
            prev = c.state.setpointC;
          }
        }
      }
    }
  });
});

describe('autopilot', () => {
  const def = DEFAULT_CURVE.id;
  const exp = { ...autopilotExperiment(def, AUTOPILOT_CANDIDATES[0]!, '2026-11-05', 7), id: 1 };

  it('starts the next untested candidate; waits for an experiment started by hand; off stops its own', () => {
    expect(autopilotStep({ enabled: true, defaultCurveId: def, running: null, history: [] })).toMatchObject({ action: 'start', curveId: 'warm-late-19-5-quiet-v1' });
    expect(nextCandidate(def, [{ autopilot: true, arms: exp.arms }])).toBe('steady-19-5-quiet-v1');
    expect(nextCandidate('steady-19-5-quiet-v1', [])).toBe('warm-late-19-5-quiet-v1');
    const all = AUTOPILOT_CANDIDATES.map((c) => ({ autopilot: true, arms: autopilotExperiment(def, c, '2026-11-05', 1).arms }));
    expect(autopilotStep({ enabled: true, defaultCurveId: def, running: null, history: all }).action).toBe('none');
    const byHand = { exp: { ...exp, autopilot: false, title: 'Aircon test' }, nights: [] };
    expect(autopilotStep({ enabled: true, defaultCurveId: def, running: byHand, history: [] }).action).toBe('none');
    expect(autopilotStep({ enabled: false, defaultCurveId: def, running: byHand, history: [] }).action).toBe('none');
    expect(autopilotStep({ enabled: false, defaultCurveId: def, running: { exp, nights: [] }, history: [] }).action).toBe('stop');
    expect(exp.minPerArm).toBe(6);
  });

  it('a test stopped early is tried again; after an adoption the old default is re-tested', () => {
    expect(nextCandidate(def, [{ autopilot: true, arms: exp.arms, status: 'stopped' }])).toBe('warm-late-19-5-quiet-v1');
    expect(nextCandidate(def, [{ autopilot: true, arms: exp.arms, status: 'finished' }])).toBe('steady-19-5-quiet-v1');
    const adopted = 'cool-early-warm-late-v1';
    const tested = EXPERIMENT_CURVES.map((c) => ({ autopilot: true, status: 'finished' as const, arms: autopilotExperiment(adopted, c.id, '2026-11-05', 1).arms }));
    expect(nextCandidate(adopted, tested)).toBe(def);
  });

  function nightsFor(better: { deep: number; aw: number; awake?: number }): ExperimentNight[] {
    const out: ExperimentNight[] = [];
    for (let i = 0; i < 14; i++) {
      const arm = i % 2 ? exp.arms[1]!.key : exp.arms[0]!.key;
      const ch = arm !== def;
      const jitter = (i * 7) % 5;
      out.push({ nightDate: day(i), armKey: arm, source: 'random', followed: true, outcomes: outcomes({ co2: 1000, deep: 55 + jitter + (ch ? better.deep : 0), awakenings: 3 + (jitter % 2) + (ch ? better.aw : 0), awake: 20 + jitter + (ch ? better.awake ?? 0 : 0) }) });
    }
    return out;
  }

  it('adopts a clear winner, but not one that costs awakenings', () => {
    const win = autopilotStep({ enabled: true, defaultCurveId: def, running: { exp, nights: nightsFor({ deep: 15, aw: -1 }) }, history: [] });
    expect(win).toMatchObject({ action: 'adopt', curveId: 'warm-late-19-5-quiet-v1' });
    const costly = autopilotStep({ enabled: true, defaultCurveId: def, running: { exp, nights: nightsFor({ deep: 40, aw: 1, awake: -20 }) }, history: [] });
    expect(costly.action).toBe('finish');
    expect(costly.reason).toMatch(/awakenings got worse/);
    const lose = autopilotStep({ enabled: true, defaultCurveId: def, running: { exp, nights: nightsFor({ deep: -15, aw: 1 }) }, history: [] });
    expect(lose.action).toBe('finish');
    const early = autopilotStep({ enabled: true, defaultCurveId: def, running: { exp, nights: nightsFor({ deep: 15, aw: -1 }).slice(0, 6) }, history: [] });
    expect(early.action).toBe('none');
  });
});

describe('migration 0025 mirrors the core curves', () => {
  const sql = readFileSync(new URL('../../../supabase/migrations/0025_experiments.sql', import.meta.url), 'utf8');

  it('inserts every experiment curve with the same phases, never as the default', () => {
    for (const c of EXPERIMENT_CURVES) {
      const m = new RegExp(`'${c.id}',\\s*'([^']+)',\\s*'(\\[[\\s\\S]*?\\])'::jsonb,\\s*(\\d+), (\\d+), (true|false)`).exec(sql);
      expect(m, c.id).not.toBeNull();
      expect(m![1]).toBe(c.name);
      expect(JSON.parse(m![2]!)).toEqual(c.phases);
      expect([Number(m![3]), Number(m![4]), m![5]]).toEqual([c.minC, c.maxC, 'false']);
    }
  });

  it('has no destructive statement words, not even in comments', () => {
    expect(sql).not.toMatch(/drop|delete|truncate/i);
  });
});
