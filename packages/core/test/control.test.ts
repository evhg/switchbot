import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CURVE,
  DEFAULT_LADDER_REMOTE,
  DEFAULT_REMOTE,
  decideAcCommand,
  evaluateLanding,
  offCommand,
  type AcCommand,
  type ControllerInput,
  type RoomReading,
} from '../src/index.ts';

const MIN = 60_000;
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
    curve: DEFAULT_CURVE,
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
    const cmd = decideAcCommand(input({ now, lastCommand: last, commandsTonight: 4, recent: flat(now - 40 * MIN, now - MIN, 20.1) }));
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
    const remote = { ...DEFAULT_REMOTE, quietAfterLightsOutMin: 30 };
    expect(decideAcCommand(input({ now: LO + 10 * MIN, lastCommand: last, remote, commandsTonight: 2 }))).toBeNull();
    expect(decideAcCommand(input({ now: LO + 31 * MIN, lastCommand: last, remote, commandsTonight: 2 }))).not.toBeNull();
  });

  it('marks a command that did not land and resends it once', () => {
    const last = on(LO + 41 * MIN, 18);
    const now = LO + 75 * MIN;
    // Room stuck at 21.5 although set 18 should give ~19.
    const recent = flat(LO + 35 * MIN, now - MIN, 21.5);
    const cmd = decideAcCommand(input({ now, lastCommand: last, commandsTonight: 4, recent }));
    expect(last.landed).toBe(false);
    expect(cmd?.reason).toMatch(/^resend/);
    expect(cmd?.state).toEqual(last.state);
    const again = decideAcCommand(input({ now: now + 35 * MIN, lastCommand: { ...cmd!, landed: false }, commandsTonight: 5, recent: flat(now, now + 34 * MIN, 21.5) }));
    expect(again?.reason ?? '').not.toMatch(/^resend/);
  });

  it('never commands a setpoint outside the curve limits', () => {
    const flat17 = { ...DEFAULT_CURVE, id: 'flat17', phases: DEFAULT_CURVE.phases.map((p) => ({ ...p, targetC: 17 })), minC: 17 };
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
