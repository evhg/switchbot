import { describe, expect, it } from 'vitest';
import {
  CURVE_V1,
  ONE_BEEP_V1,
  anchorCurve,
  resolveCurve,
  targetAt,
  DEFAULT_CURVE,
  DEFAULT_LADDER_REMOTE,
  DEFAULT_REMOTE,
  decideAcCommand,
  evaluateLanding,
  offCommand,
  planAcSchedule,
  resolveQuiet,
  withQuiet,
  type AcCommand,
  type ControllerInput,
  type RoomReading,
} from '../src/index.ts';

/**
 * Most controller mechanics (ramps, carried settle-window steps, bias recovery, fan changes) are exercised with the
 * previous default curve (CURVE_V1: a ramp and several phase steps). The current one-beep DEFAULT_CURVE has its own
 * block at the end.
 */
const V1 = CURVE_V1;
const MIN = 60_000;
/** The original closed-loop controller (quiet mode off). */
const LOUD = withQuiet(DEFAULT_REMOTE, false);
const LO = Date.UTC(2026, 9, 27, 16, 0); // 23:00 ICT
const WAKE = LO + 8 * 60 * MIN;

function flat(from: number, to: number, temp: number | ((ts: number) => number)): RoomReading[] {
  const out: RoomReading[] = [];
  for (let ts = from; ts <= to; ts += MIN) out.push({ ts, tempC: typeof temp === 'number' ? temp : temp(ts), rh: 55, co2: 900, source: 'sim' });
  return out;
}

function input(over: Partial<ControllerInput>): ControllerInput {
  const now = over.now ?? LO;
  return {
    now,
    lightsOut: LO,
    wake: WAKE,
    curve: V1,
    remote: DEFAULT_REMOTE,
    commandsTonight: 0,
    recent: flat(now - 40 * MIN, now - MIN, 22),
    ...over,
  };
}

const on = (ts: number, setpointC: number, fan: 'low' | 'high' = 'low', reason = 'curve: test'): AcCommand => ({
  ts,
  state: { power: true, setpointC, mode: 'cool', fan },
  via: 'setAll',
  reason,
  landed: null,
});

describe('decideAcCommand', () => {
  it('does nothing before pre-cool', () => {
    expect(decideAcCommand(input({ now: LO - 120 * MIN }))).toBeNull();
  });

  it('powers on at pre-cool with the default bias (bed reads ~1 °C above return air)', () => {
    const cmd = decideAcCommand(input({ now: LO - 90 * MIN, recent: flat(LO - 130 * MIN, LO - 91 * MIN, 30) }));
    expect(cmd).not.toBeNull();
    expect(cmd!.state).toEqual({ power: true, setpointC: 20, mode: 'cool', fan: 'high' });
    expect(cmd!.via).toBe('setAll');
  });

  it('respects the minimum interval', () => {
    const last = on(LO + 30 * MIN, 18);
    expect(decideAcCommand(input({ now: LO + 40 * MIN, lastCommand: last, commandsTonight: 3 }))).toBeNull();
  });

  it('respects the nightly cap and keeps the last slot for OFF', () => {
    const last = on(LO + 60 * MIN, 22);
    expect(decideAcCommand(input({ now: LO + 120 * MIN, lastCommand: last, commandsTonight: 11 }))).toBeNull();
    expect(decideAcCommand(input({ now: WAKE + 31 * MIN, lastCommand: on(WAKE - 60 * MIN, 21), commandsTonight: 11 }))?.state.power).toBe(false);
    expect(decideAcCommand(input({ now: WAKE + 31 * MIN, lastCommand: on(WAKE - 60 * MIN, 21), commandsTonight: 12 }))).toBeNull();
  });

  it('never repeats the current state', () => {
    // Deep phase target 19, bias −1 → set 18. Room settled at 19.0 under 18 → on target.
    const last = on(LO + 41 * MIN, 18);
    const now = LO + 150 * MIN;
    const recent = flat(now - 40 * MIN, now - MIN, 19);
    last.landed = true;
    expect(decideAcCommand(input({ now, lastCommand: last, commandsTonight: 4, recent }))).toBeNull();
  });

  it('follows a phase change', () => {
    const last = on(LO, 19, 'low');
    last.landed = true;
    const now = LO + 41 * MIN;
    const cmd = decideAcCommand(input({ now, lastCommand: last, commandsTonight: 2, recent: flat(now - 40 * MIN, now - MIN, 20) }));
    expect(cmd?.state.setpointC).toBe(18);
    expect(cmd?.reason).toMatch(/curve: deep/);
  });

  it('corrects when the settled room sits above target', () => {
    const last = on(LO + 41 * MIN, 18);
    last.landed = true;
    const now = LO + 150 * MIN;
    const cmd = decideAcCommand(input({ now, lastCommand: last, commandsTonight: 4, remote: LOUD, recent: flat(now - 40 * MIN, now - MIN, 20.1) }));
    expect(cmd?.state.setpointC).toBe(17);
    expect(cmd?.reason).toMatch(/correction/);
  });

  it('turns off after wake + 30 min, once', () => {
    const cmd = decideAcCommand(input({ now: WAKE + 30 * MIN, lastCommand: on(WAKE - 60 * MIN, 21), commandsTonight: 8 }));
    expect(cmd?.state.power).toBe(false);
    const off: AcCommand = { ...cmd!, landed: true };
    expect(decideAcCommand(input({ now: WAKE + 90 * MIN, lastCommand: off, commandsTonight: 9 }))).toBeNull();
  });

  it('honours quietAfterLightsOutMin', () => {
    const last = on(LO - 30 * MIN, 19, 'high');
    last.landed = true;
    const remote = { ...LOUD, quietAfterLightsOutMin: 30 };
    expect(decideAcCommand(input({ now: LO + 10 * MIN, lastCommand: last, remote, commandsTonight: 2 }))).toBeNull();
    expect(decideAcCommand(input({ now: LO + 31 * MIN, lastCommand: last, remote, commandsTonight: 2 }))).not.toBeNull();
  });

  it('marks a command that did not land and resends it once', () => {
    const last = on(LO + 41 * MIN, 18);
    const now = LO + 75 * MIN;
    // Room stuck at 21.5 although set 18 should give ~19.
    const recent = flat(LO + 35 * MIN, now - MIN, 21.5);
    const cmd = decideAcCommand(input({ now, lastCommand: last, commandsTonight: 4, recent, tonight: [last] }));
    expect(last.landed).toBe(false);
    expect(cmd?.reason).toMatch(/^resend/);
    expect(cmd?.state).toEqual(last.state);
    const resent = { ...cmd!, landed: false };
    const again = decideAcCommand(input({ now: now + 35 * MIN, lastCommand: resent, commandsTonight: 5, recent: flat(now, now + 34 * MIN, 21.5), tonight: [last, resent] }));
    expect(again?.reason ?? '').not.toMatch(/^resend/);
  });

  it('never commands a setpoint outside the curve limits', () => {
    const flat17 = { ...V1, id: 'flat17', phases: V1.phases.map((p) => ({ ...p, targetC: 17 })), minC: 17 };
    const cmd = decideAcCommand(input({ now: LO - 90 * MIN, curve: flat17, recent: [] }));
    expect(cmd?.state.setpointC).toBe(17);
  });

  it('re-sends quickly when pre-cool did not take and the room is still hot', () => {
    const last = on(LO - 60 * MIN, 19, 'high', 'resend: earlier miss');
    const now = LO - 35 * MIN;
    const cmd = decideAcCommand(input({ now, lastCommand: last, commandsTonight: 2, recent: flat(now - 30 * MIN, now - MIN, 31) }));
    expect(cmd?.reason).toMatch(/^resend: room .* not cooling/);
    expect(cmd?.state.power).toBe(true);
    // Cooling as expected: no resend.
    const cooling = flat(now - 30 * MIN, now - MIN, (ts) => 31 - ((ts - (now - 30 * MIN)) / MIN) * 0.1);
    expect(decideAcCommand(input({ now, lastCommand: last, commandsTonight: 2, recent: cooling }))?.reason ?? '').not.toMatch(/^resend/);
  });

  it('offCommand uses the learned OFF button on a ladder remote', () => {
    expect(offCommand(LO, DEFAULT_LADDER_REMOTE, undefined, 'ensure off')?.button).toBe('OFF');
    expect(offCommand(LO, DEFAULT_REMOTE, { power: true, setpointC: 19, mode: 'cool', fan: 'low' }, 'x')?.state.power).toBe(false);
  });

  it('uses learned buttons with a ladder remote', () => {
    const cmd = decideAcCommand(input({ now: LO - 90 * MIN, remote: DEFAULT_LADDER_REMOTE, recent: flat(LO - 130 * MIN, LO - 91 * MIN, 30) }));
    expect(cmd?.via).toBe('customize');
    expect(cmd?.button).toBe('C20');
    const off = decideAcCommand(input({ now: WAKE + 31 * MIN, remote: DEFAULT_LADDER_REMOTE, lastCommand: { ...cmd!, ts: WAKE - 60 * MIN, landed: true }, commandsTonight: 6 }));
    expect(off?.button).toBe('OFF');
    expect(off?.state.power).toBe(false);
  });
});

describe('evaluateLanding', () => {
  const cmd = on(LO, 18);
  it('needs ≥25 min of data', () => {
    expect(evaluateLanding(cmd, flat(LO, LO + 10 * MIN, 22))).toBeNull();
  });
  it('detects cooling', () => {
    expect(evaluateLanding(cmd, flat(LO, LO + 40 * MIN, (ts) => 22 - ((ts - LO) / MIN) * 0.05))).toBe(true);
    expect(evaluateLanding(cmd, flat(LO, LO + 40 * MIN, 22))).toBe(false);
  });
  it('detects warming after a raise', () => {
    const up = on(LO, 22);
    expect(evaluateLanding(up, flat(LO, LO + 40 * MIN, (ts) => 19 + ((ts - LO) / MIN) * 0.03))).toBe(true);
    expect(evaluateLanding(up, flat(LO, LO + 40 * MIN, 19))).toBe(false);
  });
  it('expects warming after OFF', () => {
    const off: AcCommand = { ...cmd, state: { ...cmd.state, power: false } };
    expect(evaluateLanding(off, flat(LO, LO + 40 * MIN, (ts) => 21 + ((ts - LO) / MIN) * 0.03))).toBe(true);
    expect(evaluateLanding(off, flat(LO, LO + 40 * MIN, 21))).toBe(false);
  });
});

describe('quiet mode (default)', () => {
  const deepCmd = (ts = LO + 40 * MIN) => ({ ...on(ts, 18, 'low', 'curve: deep start (quiet), 19.0°C (set 18, bias -1)'), landed: true });

  it('is on by default, also for a stored profile without `quiet`', () => {
    expect(resolveQuiet(DEFAULT_REMOTE).enabled).toBe(true);
    const legacy = { kind: 'setAll' as const, minIntervalMin: 20, maxCommandsPerNight: 12 };
    expect(resolveQuiet(legacy)).toMatchObject({ enabled: true, emergencyThresholdC: 1.5, emergencyMinMinutes: 20, maxEmergencyPerNight: 1, rampStrategy: 'third' });
  });

  it('sends no small corrections while asleep', () => {
    const now = LO + 150 * MIN;
    // Settled 1.1 °C above the deep target: closed loop corrects, quiet mode stays silent (below the 1.5 °C threshold).
    const recent = flat(now - 40 * MIN, now - MIN, 20.1);
    expect(decideAcCommand(input({ now, lastCommand: deepCmd(), commandsTonight: 3, recent, remote: LOUD }))?.reason).toMatch(/correction/);
    expect(decideAcCommand(input({ now, lastCommand: deepCmd(), commandsTonight: 3, recent }))).toBeNull();
  });

  it('moves the setpoint at a planned boundary, and skips it when the setpoint would not change', () => {
    const last = { ...on(LO, 19, 'low', 'curve: onset start'), landed: true };
    const now = LO + 41 * MIN;
    const cmd = decideAcCommand(input({ now, lastCommand: last, commandsTonight: 2, recent: flat(now - 40 * MIN, now - MIN, 20) }));
    expect(cmd?.reason).toMatch(/^curve: deep start \(quiet\)/);
    expect(cmd?.state.setpointC).toBe(18);
    // Already at 18 with the bias in use (−1: onset target 19 sent as 18): the deep boundary (19 °C) is a no-op.
    const onset19 = { ...V1, phases: V1.phases.map((p) => (p.name === 'onset' ? { ...p, targetC: 19 } : p)) };
    const at18 = { ...on(LO + 20 * MIN, 18, 'low', 'curve: onset start'), landed: true };
    expect(decideAcCommand(input({ now, curve: onset19, lastCommand: at18, commandsTonight: 2, recent: flat(now - 40 * MIN, now - MIN, 19) }))).toBeNull();
    // A re-measured bias alone never adds a beep: the room settled 0.2 °C above set 18 (bias 0 would mean set 19) → still skipped.
    const late = { ...onset19, phases: onset19.phases.map((p) => (p.name === 'deep' ? { ...p, startMin: 60 } : p)) };
    const t = LO + 61 * MIN;
    expect(decideAcCommand(input({ now: t, curve: late, lastCommand: { ...at18, ts: LO }, commandsTonight: 2, recent: flat(t - 60 * MIN, t - MIN, 18.2) }))).toBeNull();
  });

  /** Drive the controller minute by minute over [from, to) with a room that sits at setpoint + 1 °C. */
  function run(remote = DEFAULT_REMOTE, from = LO + 20 * MIN, to = WAKE, first: AcCommand = deepCmd(LO)) {
    const log: AcCommand[] = [first];
    for (let now = from; now < to; now += MIN) {
      const last = log[log.length - 1]!;
      const room = last.state.power ? last.state.setpointC + 1 : 26;
      const cmd = decideAcCommand(input({ now, lastCommand: last, commandsTonight: log.length, recent: flat(now - 60 * MIN, now - MIN, room), remote, tonight: log }));
      if (cmd) log.push({ ...cmd, landed: true });
    }
    return log.slice(1);
  }

  it('executes the middle ramp as one step at 1/3 of the ramp, to the 2/3 target', () => {
    const cmds = run();
    const ramp = cmds.filter((c) => c.ts >= LO + 240 * MIN && c.ts < LO + 360 * MIN);
    expect(ramp).toHaveLength(1);
    expect((ramp[0]!.ts - LO) / MIN).toBe(280);
    expect(ramp[0]!.state.setpointC).toBe(20); // 19 + 2/3 · 2.5 = 20.7 °C, bias −1 → 19.7 → 20
    expect(cmds.length).toBeLessThanOrEqual(4);
    // Alternatives: midpoint (one step at 300) or 'end' (none during the ramp).
    const mid = run({ ...DEFAULT_REMOTE, quiet: { rampStrategy: 'midpoint' } }).filter((c) => c.ts >= LO + 240 * MIN && c.ts < LO + 360 * MIN);
    expect(mid.map((c) => (c.ts - LO) / MIN)).toEqual([300]);
    const end = run({ ...DEFAULT_REMOTE, quiet: { rampStrategy: 'end' } }).filter((c) => c.ts >= LO + 240 * MIN && c.ts < LO + 360 * MIN);
    expect(end).toHaveLength(0);
    // Closed loop follows the ramp in several steps and keeps correcting.
    expect(run(LOUD).filter((c) => c.ts >= LO + 240 * MIN && c.ts < LO + 360 * MIN).length).toBeGreaterThan(1);
  });

  it('sends one emergency correction after ≥ 20 min ≥ 1.5 °C off target, at most once per night', () => {
    const last = deepCmd();
    const now = LO + 150 * MIN;
    const hot = flat(now - 40 * MIN, now - MIN, 20.8); // 1.8 above the deep target of 19
    const cmd = decideAcCommand(input({ now, lastCommand: last, commandsTonight: 3, recent: hot, tonight: [last] }));
    expect(cmd?.reason).toMatch(/^emergency: room 1\.8° above/);
    expect(cmd?.state.setpointC).toBe(17);
    const after = { ...cmd!, landed: true };
    expect(decideAcCommand(input({ now: now + 60 * MIN, lastCommand: after, commandsTonight: 4, recent: flat(now, now + 59 * MIN, 20.8), tonight: [last, after] }))).toBeNull();
    // Only 15 min of deviation: wait.
    const short = [...flat(now - 40 * MIN, now - 16 * MIN, 19.5), ...flat(now - 15 * MIN, now - MIN, 20.8)];
    expect(decideAcCommand(input({ now, lastCommand: last, commandsTonight: 3, recent: short, tonight: [last] }))).toBeNull();
    // Still converging toward the target: wait.
    const falling = flat(now - 40 * MIN, now - MIN, (ts) => 22.4 - ((ts - (now - 40 * MIN)) / MIN) * 0.03);
    expect(decideAcCommand(input({ now, lastCommand: last, commandsTonight: 3, recent: falling, tonight: [last] }))).toBeNull();
  });

  it('never sends an emergency setpoint outside the curve limits', () => {
    const last = { ...on(LO + 40 * MIN, 17, 'low', 'curve: deep start (quiet)'), landed: true };
    const now = LO + 150 * MIN;
    expect(decideAcCommand(input({ now, lastCommand: last, commandsTonight: 3, recent: flat(now - 40 * MIN, now - MIN, 21), tonight: [last] }))).toBeNull();
  });

  it('resends at most once while asleep, and only a planned boundary command', () => {
    const missed: AcCommand = { ...deepCmd(), landed: null };
    const now = LO + 75 * MIN;
    const stuck = flat(LO + 35 * MIN, now - MIN, 21.5);
    const r1 = decideAcCommand(input({ now, lastCommand: missed, commandsTonight: 3, recent: stuck, tonight: [missed] }));
    expect(missed.landed).toBe(false);
    expect(r1?.reason).toMatch(/^resend/);
    // A second planned command that misses is not resent again tonight.
    const late: AcCommand = { ...on(LO + 360 * MIN, 21, 'low', 'curve: late start (quiet)'), landed: false };
    const tonight = [missed, { ...r1!, landed: true }, late];
    const r2 = decideAcCommand(input({ now: LO + 400 * MIN, lastCommand: late, commandsTonight: 4, recent: flat(LO + 340 * MIN, LO + 399 * MIN, 21.9), tonight }));
    expect(r2?.reason ?? '').not.toMatch(/^resend/);
    // An emergency that did not land is not resent.
    const em: AcCommand = { ...on(LO + 150 * MIN, 17, 'low', 'emergency: room 1.8° above target'), landed: false };
    const r3 = decideAcCommand(input({ now: LO + 200 * MIN, lastCommand: em, commandsTonight: 4, recent: flat(LO + 150 * MIN, LO + 199 * MIN, 19.2), tonight: [deepCmd(), em] }));
    expect(r3?.reason ?? '').not.toMatch(/^resend/);
  });

  it('behaves as before lights-out: precool and the onset command go out as today', () => {
    const pre = decideAcCommand(input({ now: LO - 90 * MIN, recent: flat(LO - 130 * MIN, LO - 91 * MIN, 30) }));
    expect(pre?.state).toEqual({ power: true, setpointC: 20, mode: 'cool', fan: 'high' });
    const onset = decideAcCommand(input({ now: LO, lastCommand: { ...pre!, landed: true }, commandsTonight: 1, recent: flat(LO - 10 * MIN, LO - MIN, 21) }));
    expect(onset?.state.fan).toBe('low');
    // Not settled long enough to measure: the bias the precool went out with (20.5 → set 20 is bias −1, not the −0.5 rounding residue) carries on: onset 20 → set 19, as planned.
    expect(onset?.state.setpointC).toBe(19);
    const plan = planAcSchedule({ curve: V1, lightsOut: LO, wake: WAKE, remote: DEFAULT_REMOTE });
    expect(plan.commands.find((c) => c.phase === 'onset')?.state.setpointC).toBe(19);
  });
});

describe('planAcSchedule', () => {
  it('plans precool, onset, three quiet steps and OFF for the default curve', () => {
    const plan = planAcSchedule({ curve: V1, lightsOut: LO, wake: WAKE, remote: DEFAULT_REMOTE });
    const rows = plan.commands.map((c) => [(c.ts - LO) / MIN, c.state.power ? c.state.setpointC : 'off', c.kind, c.asleep]);
    expect(rows).toEqual([
      [-90, 20, 'on', false],
      [0, 19, 'phase', false],
      [40, 18, 'phase', true],
      [280, 20, 'ramp', true],
      [360, 21, 'phase', true],
      // wake (22 °C − 1 = 21) is skipped: same setpoint.
      [510, 'off', 'off', false],
    ]);
    expect(plan.asleepCount).toBe(3);
    expect(plan.total).toBe(6);
    expect(plan.quiet).toBe(true);
    expect(plan.maxExtraAsleep).toBe(1);
  });

  it('plans more commands while asleep with quiet mode off', () => {
    const quiet = planAcSchedule({ curve: V1, lightsOut: LO, wake: WAKE, remote: DEFAULT_REMOTE });
    const loud = planAcSchedule({ curve: V1, lightsOut: LO, wake: WAKE, remote: LOUD });
    expect(loud.quiet).toBe(false);
    expect(loud.asleepCount).toBeGreaterThan(quiet.asleepCount);
    expect(loud.maxExtraAsleep).toBeNull();
  });

  it('uses learned buttons with a ladder remote and stays inside the curve limits', () => {
    const plan = planAcSchedule({ curve: V1, lightsOut: LO, wake: WAKE, remote: DEFAULT_LADDER_REMOTE });
    expect(plan.commands.map((c) => c.button)).toEqual(['C20', 'C19', 'C18', 'C20', 'C21', 'OFF']);
    const cold = { ...V1, phases: V1.phases.map((p) => ({ ...p, targetC: 16 })), minC: 17 };
    for (const c of planAcSchedule({ curve: cold, lightsOut: LO, wake: WAKE, remote: DEFAULT_REMOTE }).commands) {
      if (c.state.power) expect(c.state.setpointC).toBeGreaterThanOrEqual(17);
    }
  });
});

describe('quiet mode budget and the settle window', () => {
  const deep: AcCommand = { ts: LO + 40 * MIN, state: { power: true, setpointC: 18, mode: 'cool', fan: 'low' }, via: 'setAll', reason: 'curve: deep start (quiet)', landed: true };

  it('sends no emergency or resend while asleep without `tonight` (it cannot count them)', () => {
    const now = LO + 150 * MIN;
    const hot = flat(now - 40 * MIN, now - MIN, 20.8);
    expect(decideAcCommand(input({ now, lastCommand: deep, commandsTonight: 3, recent: hot, tonight: [deep] }))?.reason).toMatch(/^emergency/);
    expect(decideAcCommand(input({ now, lastCommand: deep, commandsTonight: 3, recent: hot }))).toBeNull();
    const missed: AcCommand = { ...deep, landed: false };
    expect(decideAcCommand(input({ now: LO + 75 * MIN, lastCommand: missed, commandsTonight: 3, recent: flat(LO + 35 * MIN, LO + 74 * MIN, 21.5) }))).toBeNull();
  });

  it('shares one extra command between resends and emergencies while asleep', () => {
    const resend: AcCommand = { ...deep, ts: LO + 70 * MIN, reason: 'resend: no response to "curve: deep start (quiet)"', landed: true };
    const now = LO + 150 * MIN;
    const hot = flat(now - 40 * MIN, now - MIN, 20.8);
    expect(decideAcCommand(input({ now, lastCommand: resend, commandsTonight: 4, recent: hot, tonight: [deep, resend] }))).toBeNull();
    // With a budget of 2 the emergency may follow the resend.
    const two = { ...DEFAULT_REMOTE, quiet: { maxExtraPerNight: 2 } };
    expect(decideAcCommand(input({ now, remote: two, lastCommand: resend, commandsTonight: 4, recent: hot, tonight: [deep, resend] }))?.reason).toMatch(/^emergency/);
  });

  it('sends a phase that starts inside the settle window as a planned step, not as an emergency', () => {
    const early = { ...V1, id: 'early', phases: V1.phases.map((p) => (p.name === 'deep' ? { ...p, startMin: 10, targetC: 18 } : p)) };
    const onset: AcCommand = { ts: LO, state: { power: true, setpointC: 19, mode: 'cool', fan: 'low' }, via: 'setAll', reason: 'curve: onset phase 20.0°C (set 19)', landed: null };
    const log: AcCommand[] = [onset];
    for (let now = LO + 5 * MIN; now < LO + 120 * MIN; now += 5 * MIN) {
      const last = log.at(-1)!;
      const room = now - last.ts > 10 * MIN ? last.state.setpointC + 1 : 21;
      const cmd = decideAcCommand(input({ now, curve: early, lastCommand: last, commandsTonight: log.length, recent: flat(now - 60 * MIN, now - MIN, room), tonight: log }));
      if (cmd) log.push({ ...cmd, landed: true });
    }
    const sent = log.slice(1).map((c) => [(c.ts - LO) / MIN, c.state.setpointC, c.reason.split(' (')[0]]);
    expect(sent).toEqual([[20, 17, 'curve: deep start']]);
    // The plan shows the same command: deep, delayed by minInterval to +20, while asleep.
    const plan = planAcSchedule({ curve: early, lightsOut: LO, wake: WAKE, remote: DEFAULT_REMOTE });
    expect(plan.commands.filter((c) => c.phase === 'deep').map((c) => [(c.ts - LO) / MIN, c.state.setpointC, c.asleep])).toEqual([[20, 17, true]]);
  });
});

describe('quiet mode emergency vs. an upcoming step', () => {
  it('waits for a planned step due soon that fixes the deviation, but not for one that makes it worse', () => {
    // Middle ramp step at +280 min raises the target toward 20.7 °C.
    const last: AcCommand = { ts: LO + 40 * MIN, state: { power: true, setpointC: 18, mode: 'cool', fan: 'low' }, via: 'setAll', reason: 'curve: deep start (quiet)', landed: true };
    const now = LO + 265 * MIN;
    const base = { lightsOut: LO, wake: WAKE, curve: V1, remote: DEFAULT_REMOTE, lastCommand: last, commandsTonight: 3, tonight: [last], now };
    const cold = flat(now - 40 * MIN, now - MIN, 17.3); // 1.7 below the held 19 °C; the step will warm → wait
    expect(decideAcCommand({ ...base, recent: cold })).toBeNull();
    const hot = flat(now - 40 * MIN, now - MIN, 20.7); // 1.7 above; the warming step would not help → emergency now
    expect(decideAcCommand({ ...base, recent: hot })?.reason).toMatch(/^emergency/);
  });
});

describe('one-beep default curve (v2, anchored to sleep onset)', () => {
  const LO22 = Date.UTC(2026, 9, 29, 15, 0); // 22:00 ICT
  const WAKE830 = LO22 + 630 * MIN; // 08:30 ICT
  const at = (ts: number) => (ts - LO22) / MIN;

  it('default onset 23:00: precool 21:30, nothing at 22:00 or 23:00, ONE warming step at 03:30, OFF at 09:00', () => {
    const plan = planAcSchedule({ curve: DEFAULT_CURVE, lightsOut: LO22, wake: WAKE830, remote: DEFAULT_REMOTE });
    expect(plan.sleepOnset).toBe(LO22 + 60 * MIN);
    expect(plan.commands.map((c) => [at(c.ts), c.state.power ? c.state.setpointC : 'off', c.phase, c.asleep])).toEqual([
      [-30, 18, 'precool', false],
      [330, 20, 'middle', true], // 03:30 = onset 23:00 + 4 h 30
      [660, 'off', 'off', false], // 09:00 = wake + 30
    ]);
    expect(plan.asleepCount).toBe(1);
    expect(planAcSchedule({ curve: DEFAULT_CURVE, lightsOut: LO22, wake: WAKE830, remote: DEFAULT_LADDER_REMOTE }).commands.map((c) => c.button)).toEqual(['C18', 'C20', 'OFF']);
  });

  it('the warming step follows the night’s sleep onset; precool and OFF do not move', () => {
    for (const onsetMin of [0, 30, 90, 120]) {
      const plan = planAcSchedule({ curve: DEFAULT_CURVE, lightsOut: LO22, wake: WAKE830, remote: DEFAULT_REMOTE, sleepOnset: LO22 + onsetMin * MIN });
      expect(plan.commands.map((c) => at(c.ts)), String(onsetMin)).toEqual([-30, onsetMin + 270, 660]);
      expect(plan.asleepCount).toBe(1);
    }
    // Clamped to lights-out … +3 h: an onset before lights-out counts as lights-out.
    expect(planAcSchedule({ curve: DEFAULT_CURVE, lightsOut: LO22, wake: WAKE830, remote: DEFAULT_REMOTE, sleepOnset: LO22 - 60 * MIN }).commands[1]!.ts).toBe(LO22 + 270 * MIN);
    expect(planAcSchedule({ curve: DEFAULT_CURVE, lightsOut: LO22, wake: WAKE830, remote: DEFAULT_REMOTE, sleepOnset: LO22 + 600 * MIN }).commands[1]!.ts).toBe(LO22 + 450 * MIN);
  });

  it('targetAt / resolveCurve: sleep phases count from onset, precool and onset phase from lights-out', () => {
    const r = resolveCurve(DEFAULT_CURVE, LO22, LO22 + 60 * MIN);
    expect(r.phases.map((p) => [p.name, p.startMin])).toEqual([['precool', -30], ['onset', 0], ['deep', 90], ['middle', 330], ['late', 420], ['wake', 630]]);
    expect(r.phases.every((p) => p.anchor === undefined)).toBe(true);
    expect(targetAt(DEFAULT_CURVE, LO22, LO22 + 329 * MIN)).toBe(19);
    expect(targetAt(DEFAULT_CURVE, LO22, LO22 + 330 * MIN)).toBe(21);
    expect(targetAt(DEFAULT_CURVE, LO22, LO22 + 300 * MIN, LO22)).toBe(21);
    // Older curves are untouched by an onset.
    expect(resolveCurve(ONE_BEEP_V1, LO22, LO22 + 120 * MIN)).toBe(ONE_BEEP_V1);
    expect(resolveCurve(CURVE_V1, LO22, LO22 + 120 * MIN)).toBe(CURVE_V1);
    // anchorCurve is the inverse.
    expect(anchorCurve(r, DEFAULT_CURVE, 60)).toEqual(DEFAULT_CURVE);
  });

  for (const onsetMin of [60, 105]) {
    it(`the controller sends exactly the planned commands on an ideal night (onset +${onsetMin} min)`, () => {
      const sleepOnset = LO22 + onsetMin * MIN;
      const log: AcCommand[] = [];
      const roomAt = (ts: number) => {
        const last = log.filter((c) => c.ts <= ts).at(-1);
        if (!last) return 27;
        if (!last.state.power) return 26;
        const prev = log.filter((c) => c.ts < last.ts && c.state.power).at(-1);
        const from = prev ? prev.state.setpointC + 1 : 27;
        const to = last.state.setpointC + 1;
        return to + (from - to) * Math.exp(-(ts - last.ts) / (20 * MIN));
      };
      for (let now = LO22 - 60 * MIN; now <= WAKE830 + 120 * MIN; now += 5 * MIN) {
        const recent: RoomReading[] = [];
        for (let ts = now - 60 * MIN; ts < now; ts += MIN) recent.push({ ts, tempC: Math.round(roomAt(ts) * 10) / 10, rh: 55, co2: 800, source: 'sim' });
        const cmd = decideAcCommand({ now, lightsOut: LO22, wake: WAKE830, sleepOnset, curve: DEFAULT_CURVE, remote: DEFAULT_REMOTE, commandsTonight: log.length, recent, tonight: [...log], ...(log.at(-1) ? { lastCommand: { ...log.at(-1)! } } : {}) });
        if (cmd) log.push({ ...cmd, landed: true });
      }
      const plan = planAcSchedule({ curve: DEFAULT_CURVE, lightsOut: LO22, wake: WAKE830, remote: DEFAULT_REMOTE, sleepOnset });
      expect(log.map((c) => [at(c.ts), c.state.power ? c.state.setpointC : 'off'])).toEqual(plan.commands.map((c) => [at(c.ts), c.state.power ? c.state.setpointC : 'off']));
      expect(log.map((c) => at(c.ts))).toEqual([-30, onsetMin + 270, 660]);
    });
  }
});

describe('one-beep-v1 (stored nights, anchored to lights-out)', () => {
  const LO22 = Date.UTC(2026, 9, 29, 15, 0); // 22:00 ICT
  const WAKE630 = LO22 + 510 * MIN; // 06:30 ICT

  it('plans precool at lights-out − 30 min, nothing at lights-out, ONE warming step while asleep, OFF at wake + 30', () => {
    const plan = planAcSchedule({ curve: ONE_BEEP_V1, lightsOut: LO22, wake: WAKE630, remote: DEFAULT_REMOTE });
    const rows = plan.commands.map((c) => [(c.ts - LO22) / MIN, c.state.power ? c.state.setpointC : 'off', c.state.fan, c.phase, c.asleep]);
    expect(rows).toEqual([
      [-30, 18, 'auto', 'precool', false],
      [270, 20, 'auto', 'middle', true],
      [540, 'off', 'auto', 'off', false],
    ]);
    expect(plan.asleepCount).toBe(1);
    expect(plan.maxExtraAsleep).toBe(1);
    // A ladder remote: the same three commands.
    expect(planAcSchedule({ curve: ONE_BEEP_V1, lightsOut: LO22, wake: WAKE630, remote: DEFAULT_LADDER_REMOTE }).commands.map((c) => c.button)).toEqual(['C18', 'C20', 'OFF']);
  });

  it('a later wake moves only the OFF: still one command while asleep', () => {
    const plan = planAcSchedule({ curve: ONE_BEEP_V1, lightsOut: LO22, wake: LO22 + 600 * MIN, remote: DEFAULT_REMOTE });
    expect(plan.asleepCount).toBe(1);
    expect(plan.commands.at(-1)!.ts).toBe(LO22 + 630 * MIN);
  });

  it('the controller sends the same three commands on an ideal night (room follows the setpoint + 1 °C)', () => {
    const log: AcCommand[] = [];
    const roomAt = (ts: number) => {
      const last = log.filter((c) => c.ts <= ts).at(-1);
      if (!last) return 27;
      if (!last.state.power) return 26;
      // First-order pull toward setpoint + 1 with a 20 min time constant, from the previous level.
      const prev = log.filter((c) => c.ts < last.ts && c.state.power).at(-1);
      const from = prev ? prev.state.setpointC + 1 : 27;
      const to = last.state.setpointC + 1;
      return to + (from - to) * Math.exp(-(ts - last.ts) / (20 * MIN));
    };
    for (let now = LO22 - 60 * MIN; now <= WAKE630 + 120 * MIN; now += 5 * MIN) {
      const recent: RoomReading[] = [];
      for (let ts = now - 60 * MIN; ts < now; ts += MIN) recent.push({ ts, tempC: Math.round(roomAt(ts) * 10) / 10, rh: 55, co2: 800, source: 'sim' });
      const cmd = decideAcCommand({ now, lightsOut: LO22, wake: WAKE630, curve: ONE_BEEP_V1, remote: DEFAULT_REMOTE, commandsTonight: log.length, recent, tonight: [...log], ...(log.at(-1) ? { lastCommand: { ...log.at(-1)! } } : {}) });
      if (cmd) log.push({ ...cmd, landed: true });
    }
    const plan = planAcSchedule({ curve: ONE_BEEP_V1, lightsOut: LO22, wake: WAKE630, remote: DEFAULT_REMOTE });
    expect(log.map((c) => [(c.ts - LO22) / MIN, c.state.power ? c.state.setpointC : 'off'])).toEqual(
      plan.commands.map((c) => [(c.ts - LO22) / MIN, c.state.power ? c.state.setpointC : 'off']),
    );
  });
});
