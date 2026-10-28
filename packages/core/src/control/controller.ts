import type { AcCommand, AcState, FanSpeed, Ms, RoomReading, TemperatureCurve } from '../types.ts';
import { phaseAt, targetAt } from '../curve.ts';
import type { RemoteProfile } from './remote.ts';

const MIN = 60_000;
/** Assumed bed-minus-setpoint offset before the room has settled (bed sensor reads warmer than return air). */
const DEFAULT_OFFSET_C = 1;
/** Only act when the predicted bed temperature is this far off target. */
const DEADBAND_C = 0.6;
const SETTLE_MIN = 45;
const LANDING_MIN = 30;
/** Room this far above target and not cooling (before/around lights-out) = the AC probably isn't on. */
const STALLED_ABOVE_C = 2.5;

export interface ControllerInput {
  now: Ms;
  lightsOut: Ms;
  wake: Ms;
  curve: TemperatureCurve;
  remote: RemoteProfile;
  /** Our assumed current AC state. */
  lastCommand?: AcCommand;
  commandsTonight: number;
  /** Last ≥30 min of readings, ascending. */
  recent: RoomReading[];
  /** Optional prior bias (setpoint − bed target), e.g. learned on earlier nights. Default −1. */
  biasC?: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function sameState(a: AcState, b: AcState): boolean {
  if (!a.power && !b.power) return true;
  return a.power === b.power && a.setpointC === b.setpointC && a.mode === b.mode && a.fan === b.fan;
}

function makeCommand(now: Ms, state: AcState, remote: RemoteProfile, reason: string): AcCommand | null {
  if (remote.kind === 'setAll') return { ts: now, state, via: 'setAll', reason, landed: null };
  const ladder = remote.ladder ?? [];
  let best: { button: string; state: AcState } | undefined;
  for (const step of ladder) {
    if (step.state.power !== state.power) continue;
    if (!state.power) {
      best = step;
      break;
    }
    if (!best || Math.abs(step.state.setpointC - state.setpointC) < Math.abs(best.state.setpointC - state.setpointC)) {
      best = step;
    }
  }
  if (!best) return null;
  return { ts: now, state: { ...best.state }, via: 'customize', button: best.button, reason, landed: null };
}

/** OFF in the remote's vocabulary (setAll or the learned OFF button). */
export function offCommand(now: Ms, remote: RemoteProfile, last: AcState | undefined, reason: string): AcCommand | null {
  return makeCommand(now, { power: false, setpointC: last?.setpointC ?? 24, mode: 'cool', fan: 'auto' }, remote, reason);
}

/** Room still far above target and not falling over the last ~15 min (null = too little data). */
function stalledAbove(recent: RoomReading[], now: Ms, target: number): number | null {
  const tail = recent.filter((r) => r.ts > now - 5 * MIN && r.ts <= now);
  const head = recent.filter((r) => r.ts > now - 20 * MIN && r.ts <= now - 15 * MIN);
  if (tail.length < 3 || head.length < 3) return null;
  const t = mean(tail.map((r) => r.tempC));
  const falling = t - mean(head.map((r) => r.tempC)) < -0.3;
  return !falling && t - target > STALLED_ABOVE_C ? t - target : null;
}

/**
 * Did the room respond to `cmd`? Looks at readings 20–40 min after it. Expects warming after OFF, cooling
 * when the room was well above setpoint + offset, warming when well below. null = not enough data yet.
 */
export function evaluateLanding(
  cmd: AcCommand,
  readingsAfter: RoomReading[],
  opts: { offsetC?: number } = {},
): boolean | null {
  const win = readingsAfter.filter((r) => r.ts >= cmd.ts && r.ts <= cmd.ts + 40 * MIN);
  const last = win[win.length - 1];
  if (!last || last.ts - cmd.ts < 25 * MIN) return null;
  const t0 = mean(win.slice(0, 3).map((r) => r.tempC));
  const later = win.filter((r) => r.ts >= cmd.ts + 20 * MIN).map((r) => r.tempC);
  if (later.length === 0) return null;
  const lo = Math.min(...later);
  const hi = Math.max(...later);
  if (!cmd.state.power) return hi - t0 >= 0.3;
  const expected = cmd.state.setpointC + (opts.offsetC ?? DEFAULT_OFFSET_C);
  const gap = expected - t0;
  if (gap <= -0.7) return t0 - lo >= 0.3;
  if (gap >= 0.7) return hi - t0 >= 0.2;
  return Math.abs(mean(later) - expected) <= 1;
}

/**
 * Bed-minus-setpoint offset. Measured once the room has settled under the current setpoint; otherwise the
 * offset implied by the last command (target at that time − setpoint), so no state is needed between calls.
 */
function offsetEstimate(input: ControllerInput): { offset: number; settledMean: number | null } {
  const { lastCommand, now, recent, curve, lightsOut } = input;
  const prior = -(input.biasC ?? -DEFAULT_OFFSET_C);
  if (!lastCommand?.state.power) return { offset: prior, settledMean: null };
  const sp = lastCommand.state.setpointC;
  const tAtCmd = targetAt(curve, lightsOut, lastCommand.ts);
  const implied = tAtCmd === null ? prior : clamp(tAtCmd - sp, -2, 2);
  if (now - lastCommand.ts < SETTLE_MIN * MIN) return { offset: implied, settledMean: null };
  const win = recent.filter((r) => r.ts > now - 30 * MIN && r.ts <= now);
  if (win.length < 20) return { offset: implied, settledMean: null };
  const head = mean(win.slice(0, 8).map((r) => r.tempC));
  const tail = mean(win.slice(-8).map((r) => r.tempC));
  // Still drifting (pull-down or capacity-limited): don't trust it as a steady-state offset.
  if (Math.abs(tail - head) > 0.25) return { offset: implied, settledMean: null };
  const m = mean(win.map((r) => r.tempC));
  // Move at most 1 °C away from what we assumed last time, so one odd window can't swing the setpoint far.
  return { offset: clamp(m - sp, Math.max(-2, implied - 1), Math.min(2, implied + 1)), settledMean: m };
}

export function decideAcCommand(input: ControllerInput): AcCommand | null {
  const { now, lightsOut, wake, curve, remote, lastCommand, commandsTonight, recent } = input;
  const firstStart = Math.min(0, curve.phases[0]?.startMin ?? 0);
  const onFrom = lightsOut + firstStart * MIN;
  const offAt = wake + 30 * MIN;
  if (now < onFrom) return null;
  if (lastCommand && now - lastCommand.ts < remote.minIntervalMin * MIN) return null;
  if (commandsTonight >= remote.maxCommandsPerNight) return null;

  // Landing check (mutates the prior command so the log shows it).
  if (lastCommand && (lastCommand.landed === undefined || lastCommand.landed === null) && now - lastCommand.ts >= LANDING_MIN * MIN) {
    lastCommand.landed = evaluateLanding(lastCommand, recent.filter((r) => r.ts >= lastCommand.ts));
  }
  const lastOn = lastCommand?.state.power ?? false;
  const wantOn = now < offAt;

  const slotFree = !wantOn || commandsTonight < remote.maxCommandsPerNight - 1;
  if (lastCommand && lastCommand.landed === false && !lastCommand.reason.startsWith('resend') && lastOn === wantOn && slotFree) {
    return { ...lastCommand, ts: now, state: { ...lastCommand.state }, reason: `resend: no response to "${lastCommand.reason}"`, landed: null };
  }

  if (!wantOn) {
    if (!lastOn) return null;
    return offCommand(now, remote, lastCommand?.state, 'schedule: off (wake + 30 min)');
  }

  const q = remote.quietAfterLightsOutMin ?? 0;
  if (q > 0 && now >= lightsOut && now < lightsOut + q * MIN) return null;
  // Keep the last slot for the morning OFF.
  if (commandsTonight >= remote.maxCommandsPerNight - 1) return null;

  const target = targetAt(curve, lightsOut, now);
  if (target === null) return null;
  const phase = phaseAt(curve, lightsOut, now)?.phase.name ?? 'precool';
  const fan: FanSpeed = remote.kind === 'customize' ? 'auto' : phase === 'precool' ? 'high' : 'low';
  const { offset, settledMean } = offsetEstimate(input);
  const bias = clamp(Math.round(-offset), -2, 2);
  // minC/maxC bound the setpoint itself (hard safety limits), not only the room target.
  const lo = Math.max(16, Math.ceil(curve.minC));
  const hi = Math.min(30, Math.floor(curve.maxC));
  const sp = clamp(Math.round(target + bias), lo, hi);
  const desired: AcState = { power: true, setpointC: sp, mode: 'cool', fan };

  if (!lastOn || !lastCommand) {
    return makeCommand(now, desired, remote, `curve: ${phase} start, ${target.toFixed(1)}°C (set ${sp}, bias ${bias >= 0 ? '+' : ''}${bias})`);
  }
  const cur = lastCommand.state;
  // Precool / early night: if the last command hasn't been confirmed and the room is still hot and not
  // cooling, the IR frame was probably lost — re-send the full state at minInterval instead of waiting to settle.
  if (lastCommand.landed !== true && now < lightsOut + 60 * MIN) {
    const above = stalledAbove(recent, now, target);
    if (above !== null) return makeCommand(now, desired, remote, `resend: room ${above.toFixed(1)}° above target and not cooling`);
  }
  const predicted = settledMean ?? cur.setpointC + offset;
  const err = predicted - target;
  const fanOnly = cur.setpointC === sp && cur.fan !== fan;
  if (Math.abs(err) < DEADBAND_C && !fanOnly) return null;
  if (sameState(cur, desired)) return null;
  const cmd = fanOnly
    ? makeCommand(now, desired, remote, `curve: ${phase}, fan ${fan}`)
    : settledMean !== null && settledMean - target > STALLED_ABOVE_C
      ? makeCommand(now, desired, remote, `resend: full state (room ${err.toFixed(1)}° above target)`)
    : settledMean !== null && Math.abs(settledMean - target) >= DEADBAND_C
      ? makeCommand(now, desired, remote, `correction: ${sp - cur.setpointC >= 0 ? '+' : ''}${sp - cur.setpointC} (room ${Math.abs(err).toFixed(1)}° ${err > 0 ? 'above' : 'below'} target)`)
      : makeCommand(now, desired, remote, `curve: ${phase} phase ${target.toFixed(1)}°C (set ${sp})`);
  // A ladder may map to the same button we already pressed.
  if (!cmd || (lastCommand.button !== undefined && cmd.button === lastCommand.button) || sameState(cur, cmd.state)) return null;
  return cmd;
}
