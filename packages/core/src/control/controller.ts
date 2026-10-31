import type { AcCommand, AcState, FanSpeed, Ms, RoomReading, TemperatureCurve } from '../types.ts';
import { phaseAt, resolveCurve, targetAt, usesSleepOnset } from '../curve.ts';
import { remoteCommand, resolveQuiet, type RemoteProfile, type ResolvedQuiet } from './remote.ts';
import { asleepFrom, carriedStepSuperseded, fanFor, quietSteps, recoverBias, setpointLimits, STEP_GRACE_MIN, stepDeadline, type QuietStep } from './quiet.ts';

const MIN = 60_000;
/** Assumed bed-minus-setpoint offset before the room has settled (bed sensor reads warmer than return air). */
const DEFAULT_OFFSET_C = 1;
/** Only act when the predicted bed temperature is this far off target. */
const DEADBAND_C = 0.6;
const SETTLE_MIN = 45;
/** A command is judged this long after it was sent (controller and ac-curve alike). */
export const LANDING_MIN = 30;
/** A cooling command only counts as landed when the pull-down starts within this many minutes of it. */
const LANDING_ONSET_MIN = 20;
/**
 * Cron ticks fire a second or two late, so a command sent at 21:50:01 would miss the 22:10:00 tick by 1.5 s and
 * minInterval would become 25 min. Allow this much slack (well under a tick).
 */
export const INTERVAL_SLACK_MS = 30_000;
/**
 * Resends per night because the room is still hot and not cooling (the AC ignored the frame): spaced by minInterval,
 * only while people are still awake (before the expected sleep onset). Each is one beep.
 */
export const MAX_STALLED_RESENDS = 2;
/** An unanswered power-on command counts as ignored by the AC this long after it was sent. */
const UNRESPONSIVE_AFTER_MIN = 20;
/** Quiet mode: a measured bias replaces the one in use only when it differs by more than this (no flip-flop around x.5). */
const BIAS_HYSTERESIS_C = 0.75;
/** Room this far above target and not cooling (before/around lights-out) = the AC probably isn't on. */
const STALLED_ABOVE_C = 2.5;
/**
 * A too-warm room still falling faster than this (°C/h, least-squares slope over the last TREND_WINDOW_MIN) is still
 * being cooled: the AC is doing what it can and a colder setpoint would only beep. −0.3 °C/h is 0.15 °C over 30 min,
 * well above the slope noise of 1-min readings at 0.1 °C resolution, and well below the −0.8 °C/h of the 2026-10-31
 * incident (21.7 → 21.3 °C in 30 min under Cool 17, when an emergency "set 16" went out and the unit stopped cooling).
 * Mirrored for a warming emergency (emergencyWarm): a too-cold room already rising faster than +0.3 °C/h is left alone.
 */
export const STILL_MOVING_C_PER_H = 0.3;
/** Window for the room trend behind STILL_MOVING_C_PER_H. */
export const TREND_WINDOW_MIN = 30;

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
  /**
   * Tonight's commands so far, ascending (should include lastCommand). Quiet mode needs it to count tonight's
   * emergencies and resends while asleep; without it quiet mode sends no emergency or resend while asleep (only the
   * planned steps), so the nightly budget can never be exceeded by a caller that cannot count.
   */
  tonight?: AcCommand[];
  /**
   * Expected sleep onset (Night.sleepOnset). Only curves with phases anchored to 'sleepOnset' use it; default
   * lights-out + 60 min. planAcSchedule must get the same value to plan the same steps.
   */
  sleepOnset?: Ms;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Has minInterval passed since `lastTs` (with INTERVAL_SLACK_MS for cron jitter)? */
export function minIntervalPassed(now: Ms, lastTs: Ms, remote: RemoteProfile): boolean {
  return now - lastTs >= remote.minIntervalMin * MIN - INTERVAL_SLACK_MS;
}

/** Until when people are assumed awake: the expected sleep onset (default lights-out + 60 min). */
const awakeUntil = (input: ControllerInput) => Math.max(input.lightsOut, input.sleepOnset ?? input.lightsOut + 60 * MIN);
/** A resend because the room stayed hot (stalledAbove), as opposed to one after a failed landing check. */
const isStalledResend = (c: AcCommand) => c.reason.startsWith('resend: room ');

/**
 * May a stalled resend go out now? Only before the expected sleep onset and at most MAX_STALLED_RESENDS resends of
 * any kind tonight. Without `tonight` (cannot count): never a resend of a resend.
 */
function stalledResendAllowed(input: ControllerInput): boolean {
  const { now, lastCommand, tonight } = input;
  if (!lastCommand || now >= awakeUntil(input)) return false;
  if (!tonight) return !lastCommand.reason.startsWith('resend');
  return tonight.filter((c) => c.reason.startsWith('resend')).length < MAX_STALLED_RESENDS;
}

function sameState(a: AcState, b: AcState): boolean {
  if (!a.power && !b.power) return true;
  return a.power === b.power && a.setpointC === b.setpointC && a.mode === b.mode && a.fan === b.fan;
}

function makeCommand(now: Ms, state: AcState, remote: RemoteProfile, reason: string): AcCommand | null {
  return remoteCommand(now, state, remote, reason);
}

/** OFF in the remote's vocabulary (setAll or the learned OFF button). */
export function offCommand(now: Ms, remote: RemoteProfile, last: AcState | undefined, reason: string): AcCommand | null {
  return makeCommand(now, { power: false, setpointC: last?.setpointC ?? 24, mode: 'cool', fan: 'auto' }, remote, reason);
}

/**
 * Least-squares slope of the room over the last `minutes` (°C per hour); null when the readings cover less than two
 * thirds of the window (too little data to tell a slow fall from a flat room).
 */
export function roomTrendCPerH(recent: RoomReading[], now: Ms, minutes = TREND_WINDOW_MIN): number | null {
  const win = recent.filter((r) => r.ts > now - minutes * MIN && r.ts <= now);
  if (win.length < Math.max(5, Math.ceil(minutes / 3))) return null;
  if (win[win.length - 1]!.ts - win[0]!.ts < (minutes * 2 * MIN) / 3) return null;
  const xs = win.map((r) => (r.ts - now) / (60 * MIN));
  const ys = win.map((r) => r.tempC);
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
  }
  return sxx > 0 ? sxy / sxx : null;
}

/**
 * Is the room still moving toward the target on its own (a too-warm room falling, `above` true; a too-cold one
 * rising) faster than STILL_MOVING_C_PER_H? Unknown trend (too little data) counts as moving: no correction beeps
 * on a guess.
 */
function stillConverging(recent: RoomReading[], now: Ms, above: boolean): boolean {
  const slope = roomTrendCPerH(recent, now);
  if (slope === null) return true;
  return above ? slope <= -STILL_MOVING_C_PER_H : slope >= STILL_MOVING_C_PER_H;
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
 * Cooling must start within LANDING_ONSET_MIN of the command (a later drop, e.g. someone using the handheld remote,
 * is not credited to it) and reach a drop that grows with the gap (0.3–0.8 °C), judged on the mean of the last
 * readings so one low sample cannot decide it.
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
  const hi = Math.max(...later);
  if (!cmd.state.power) return hi - t0 >= 0.3;
  const expected = cmd.state.setpointC + (opts.offsetC ?? DEFAULT_OFFSET_C);
  const gap = expected - t0;
  if (gap <= -0.7) {
    const firstDrop = win.find((r) => r.tempC <= t0 - 0.3);
    if (!firstDrop || firstDrop.ts - cmd.ts > LANDING_ONSET_MIN * MIN) return false;
    return t0 - mean(later.slice(-5)) >= clamp(-gap * 0.15, 0.3, 0.8) - 1e-9;
  }
  if (gap >= 0.7) return hi - t0 >= 0.2;
  return Math.abs(mean(later) - expected) <= 1;
}

/** The whole-degree prior bias (setpoint − bed target): input.biasC rounded, default −1. */
const priorBias = (input: ControllerInput) => clamp(Math.round(input.biasC ?? -DEFAULT_OFFSET_C), -2, 2);

/**
 * Bed-minus-setpoint offset. Measured once the room has settled under the current setpoint; otherwise the
 * offset implied by the last command (the whole-degree bias it was sent with, see recoverBias), so no state is
 * needed between calls.
 */
function offsetEstimate(input: ControllerInput): { offset: number; settledMean: number | null } {
  const { lastCommand, now, recent, curve, lightsOut } = input;
  const prior = -(input.biasC ?? -DEFAULT_OFFSET_C);
  if (!lastCommand?.state.power) return { offset: prior, settledMean: null };
  const sp = lastCommand.state.setpointC;
  const tAtCmd = targetAt(curve, lightsOut, lastCommand.ts);
  const implied = tAtCmd === null ? prior : -recoverBias(sp, tAtCmd, setpointLimits(curve), priorBias(input));
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
  // Onset-anchored curve: resolve it for this night once, so everything below counts from lights-out.
  if (usesSleepOnset(input.curve)) return decideAcCommand({ ...input, curve: resolveCurve(input.curve, input.lightsOut, input.sleepOnset) });
  const { now, lightsOut, wake, curve, remote, lastCommand, commandsTonight, recent } = input;
  const firstStart = Math.min(0, curve.phases[0]?.startMin ?? 0);
  const onFrom = lightsOut + firstStart * MIN;
  const offAt = wake + 30 * MIN;
  if (now < onFrom) return null;
  if (lastCommand && !minIntervalPassed(now, lastCommand.ts, remote)) return null;
  if (commandsTonight >= remote.maxCommandsPerNight) return null;

  // Landing check (mutates the prior command so the log shows it).
  if (lastCommand && (lastCommand.landed === undefined || lastCommand.landed === null) && now - lastCommand.ts >= LANDING_MIN * MIN) {
    lastCommand.landed = evaluateLanding(lastCommand, recent.filter((r) => r.ts >= lastCommand.ts));
  }
  const lastOn = lastCommand?.state.power ?? false;
  const wantOn = now < offAt;

  const quiet = resolveQuiet(remote);
  if (quiet.enabled && wantOn && now >= asleepFrom(lightsOut, quiet)) return decideQuiet(input, quiet);

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
  const fan: FanSpeed = fanFor(remote, phase, curve);
  const { offset, settledMean } = offsetEstimate(input);
  const bias = clamp(Math.round(-offset), -2, 2);
  // minC/maxC bound the setpoint itself (hard safety limits), not only the room target.
  const { lo, hi } = setpointLimits(curve);
  const sp = clamp(Math.round(target + bias), lo, hi);
  const desired: AcState = { power: true, setpointC: sp, mode: 'cool', fan };

  if (!lastOn || !lastCommand) {
    return makeCommand(now, desired, remote, `curve: ${phase} start, ${target.toFixed(1)}°C (set ${sp}, bias ${bias >= 0 ? '+' : ''}${bias})`);
  }
  const cur = lastCommand.state;
  // If the last command hasn't been confirmed and the room is still hot and not cooling, the IR frame was probably lost
  // or ignored: re-send the full state at minInterval instead of waiting to settle. At most MAX_STALLED_RESENDS a
  // night and only before the expected sleep onset (the receiver beeps); after lights-out never warmer than now.
  if (lastCommand.landed !== true && stalledResendAllowed(input)) {
    const above = stalledAbove(recent, now, target);
    const state = now >= lightsOut ? { ...desired, setpointC: Math.min(desired.setpointC, cur.setpointC) } : desired;
    if (above !== null) return makeCommand(now, state, remote, `resend: room ${above.toFixed(1)}° above target and not cooling`);
  }
  const predicted = settledMean ?? cur.setpointC + offset;
  const err = predicted - target;
  const fanOnly = cur.setpointC === sp && cur.fan !== fan;
  if (Math.abs(err) < DEADBAND_C && !fanOnly) return null;
  if (sameState(cur, desired)) return null;
  // From lights-out a measured too-warm room gets the same guards as the quiet-mode emergency: only a strictly colder
  // setpoint (at the SETALL_MIN_C floor there is nothing left to send), and only once the room has stopped cooling.
  if (now >= lightsOut && settledMean !== null && err > 0 && !fanOnly) {
    if (sp >= cur.setpointC || stillConverging(recent, now, true)) return null;
  }
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

/**
 * The target quiet mode is holding at `ts`: the latest planned step's target (so a ramp reads as the staircase quiet
 * mode actually executes), else the curve.
 */
function heldTarget(input: ControllerInput, steps: QuietStep[], ts: Ms): number | null {
  const st = steps.filter((x) => x.ts <= ts).at(-1);
  return st ? st.targetC : targetAt(input.curve, input.lightsOut, ts);
}

/**
 * Bed-minus-setpoint offset measured over the 30 min before `at` (the step's time, so a step delayed by minInterval
 * gets the same answer on every tick) once the setpoint had been unchanged for SETTLE_MIN and the room was steady
 * (a fan-only change does not restart the clock); null when it can't be measured.
 */
function quietOffset(input: ControllerInput, tonight: AcCommand[], at: Ms): number | null {
  const { recent, lastCommand } = input;
  const now = at;
  if (!lastCommand?.state.power) return null;
  const sp = lastCommand.state.setpointC;
  let since = lastCommand.ts;
  for (let i = tonight.length - 1; i >= 0; i--) {
    const c = tonight[i]!;
    if (c.ts > lastCommand.ts || c.ts > at) continue;
    if (!c.state.power || c.state.setpointC !== sp) break;
    since = Math.min(since, c.ts);
  }
  if (now - since < SETTLE_MIN * MIN) return null;
  const win = recent.filter((r) => r.ts > now - 30 * MIN && r.ts <= now);
  if (win.length < 20) return null;
  const head = mean(win.slice(0, 8).map((r) => r.tempC));
  const tail = mean(win.slice(-8).map((r) => r.tempC));
  if (Math.abs(tail - head) > 0.25) return null;
  return mean(win.map((r) => r.tempC)) - sp;
}

/** Readings of the last `minutes` all ≥ threshold away from the held target on the same side; mean deviation, or null. */
function sustainedDeviation(input: ControllerInput, quiet: ResolvedQuiet, steps: QuietStep[]): number | null {
  const { now, recent } = input;
  const win = recent.filter((r) => r.ts > now - quiet.emergencyMinMinutes * MIN && r.ts <= now);
  // Need most of the window covered; a gap must not count as "deviating for 20 min".
  if (win.length < Math.max(3, Math.ceil(quiet.emergencyMinMinutes * 0.75))) return null;
  if (win[0]!.ts > now - (quiet.emergencyMinMinutes - 3) * MIN) return null;
  const devs: number[] = [];
  for (const r of win) {
    const t = heldTarget(input, steps, r.ts);
    if (t === null) return null;
    devs.push(r.tempC - t);
  }
  const thr = quiet.emergencyThresholdC;
  if (!(devs.every((d) => d >= thr) || devs.every((d) => d <= -thr))) return null;
  // Still converging toward the target (e.g. pulling down after a step): give it time, don't beep.
  const k = Math.min(5, Math.floor(devs.length / 3));
  const early = Math.abs(mean(devs.slice(0, k)));
  const late = Math.abs(mean(devs.slice(-k)));
  if (early - late >= 0.3) return null;
  return mean(devs);
}

/**
 * Quiet mode from lights-out + settle until the OFF at wake + 30 min: the receiver beeps on every frame, so only
 *  1. the planned steps from quietSteps (phase starts, one step per ramp, plus any step of the settle window the closed
 *     loop could not send yet), skipped when the setpoint would not change under the bias in use;
 *  2. at most maxExtraPerNight extra commands in total (default 1), each either
 *     - a resend of a planned "curve: …" command that did not land (not of a fan-only change), or
 *     - an emergency correction (at most maxEmergencyPerNight), when the bed-height room has been ≥ threshold off
 *       target for ≥ emergencyMinMinutes (and the last command is older than the settle time, and no planned step
 *       that fixes it is due within 30 min). Only a room that is too WARM is corrected (cooling) unless
 *       quiet.emergencyWarm: a too-cold room is never warmed while asleep. Never while the room is still moving
 *       toward the target (falling ≥ STILL_MOVING_C_PER_H over TREND_WINDOW_MIN), and only to a setpoint strictly
 *       colder than the last command: at the 17 °C floor (SETALL_MIN_C) no emergency is sent at all.
 *     Extras need `tonight` to count them; without it none are sent while asleep.
 * minInterval, the nightly cap and the curve's minC/maxC still apply.
 *
 * Bias: the one the last command was sent with (recoverBias; an emergency's setpoint carries its correction forward),
 * replaced by the measured offset only when that differs by more than BIAS_HYSTERESIS_C (and by at most 1 °C). A
 * re-measured bias never adds a beep by itself: a step whose setpoint would not change under the bias in use is skipped.
 */
function decideQuiet(input: ControllerInput, quiet: ResolvedQuiet): AcCommand | null {
  const { now, lightsOut, wake, curve, remote, lastCommand, commandsTonight } = input;
  // Keep the last slot for the morning OFF.
  if (commandsTonight >= remote.maxCommandsPerNight - 1) return null;
  const from = asleepFrom(lightsOut, quiet);
  const tonight = input.tonight ?? (lastCommand ? [lastCommand] : []);
  const asleep = tonight.filter((c) => c.ts >= from);
  const emergencies = asleep.filter((c) => c.reason.startsWith('emergency')).length;
  // Stalled resends before the expected sleep onset (people still awake) have their own cap, not this budget.
  const extras = emergencies + asleep.filter((c) => c.reason.startsWith('resend') && !(isStalledResend(c) && c.ts < awakeUntil(input))).length;
  const extraLeft = input.tonight !== undefined && extras < quiet.maxExtraPerNight;
  const limits = setpointLimits(curve);
  const { lo, hi } = limits;
  const phase = phaseAt(curve, lightsOut, now)?.phase.name ?? 'precool';
  const fan = fanFor(remote, phase, curve);
  const steps = quietSteps(curve, lightsOut, wake, quiet);
  const step = steps.filter((st) => st.ts <= now).at(-1);
  const nextStep = steps.find((st) => st.ts > now);
  const prior = priorBias(input);

  // AC assumed off (controller enabled mid-night, or never commanded): one command brings it back on the curve.
  if (!lastCommand || !lastCommand.state.power) {
    const target = step && now < stepDeadline(step, from) ? step.targetC : targetAt(curve, lightsOut, now);
    if (target === null) return null;
    const sp = clamp(Math.round(target + prior), lo, hi);
    return makeCommand(now, { power: true, setpointC: sp, mode: 'cool', fan }, remote, `curve: ${phase} (quiet), AC assumed off, ${target.toFixed(1)}°C (set ${sp})`);
  }
  const cur = lastCommand.state;

  // A fan-only change (e.g. the onset command keeps the precool setpoint) can't be judged from the temperature, and a
  // missed fan change is harmless: not worth a beep while asleep.
  const prev = tonight.filter((c) => c.ts < lastCommand.ts).at(-1);
  const fanOnly = prev !== undefined && prev.state.power && prev.state.setpointC === cur.setpointC;
  if (lastCommand.landed === false && lastCommand.reason.startsWith('curve:') && !fanOnly && extraLeft) {
    return { ...lastCommand, ts: now, state: { ...lastCommand.state }, reason: `resend: no response to "${lastCommand.reason}"`, landed: null };
  }

  // Still awake and the AC ignored the last command(s): the same capped stalled resend as before quiet mode, of the
  // state we already sent (cooling only).
  if (lastCommand.landed !== true && stalledResendAllowed(input)) {
    const held = heldTarget(input, steps, now);
    const above = held === null ? null : stalledAbove(input.recent, now, held);
    if (above !== null) return { ...lastCommand, ts: now, state: { ...cur }, reason: `resend: room ${above.toFixed(1)}° above target and not cooling (quiet)`, landed: null };
  }

  if (step && lastCommand.ts < step.ts && now < stepDeadline(step, from) && !carriedStepSuperseded(step, nextStep, now, from)) {
    const heldAtLast = heldTarget(input, steps, lastCommand.ts);
    // Up to ±4: an emergency may have moved the setpoint past the ±2 a measurement allows; keep what it established.
    const inUse = heldAtLast === null ? prior : recoverBias(cur.setpointC, heldAtLast, limits, prior, 4);
    // Would the step change anything under the bias in use? If not, skip it: a re-measurement alone never beeps.
    const plain = makeCommand(now, { power: true, setpointC: clamp(Math.round(step.targetC + inUse), lo, hi), mode: 'cool', fan }, remote, '');
    const noChange = !plain || sameState(cur, plain.state) || (lastCommand.button !== undefined && plain.button === lastCommand.button);
    const measured = noChange ? null : quietOffset(input, tonight, step.ts);
    const bias =
      measured === null || Math.abs(-measured - inUse) <= BIAS_HYSTERESIS_C ? inUse : clamp(Math.round(-measured), Math.max(-2, inUse - 1), Math.min(2, inUse + 1));
    let sp = clamp(Math.round(step.targetC + bias), lo, hi);
    // Never move the setpoint against the plan (a re-measured bias must not turn a warming step into a cooling one).
    const dir = Math.sign(step.targetC - (heldTarget(input, steps, step.ts - MIN) ?? step.targetC));
    if ((dir > 0 && sp < cur.setpointC) || (dir < 0 && sp > cur.setpointC)) sp = cur.setpointC;
    const label = step.kind === 'ramp' ? `${step.phase} ramp (one step)` : `${step.phase} start`;
    const cmd = makeCommand(now, { power: true, setpointC: sp, mode: 'cool', fan }, remote, `curve: ${label} (quiet), ${step.targetC.toFixed(1)}°C (set ${sp}, bias ${bias >= 0 ? '+' : ''}${bias})`);
    const unchanged = noChange || !cmd || sameState(cur, cmd.state) || (lastCommand.button !== undefined && cmd.button === lastCommand.button);
    if (!unchanged) return cmd;
  }

  if (!extraLeft || emergencies >= quiet.maxEmergencyPerNight) return null;
  if (now - lastCommand.ts < Math.max(SETTLE_MIN, quiet.emergencyMinMinutes) * MIN) return null;
  // The whole deviation window must lie after asleepFrom: readings from the evening pull-down (still converging after
  // the pre-cool ON) must not trigger the one emergency, which then holds for the rest of the night.
  if (now - quiet.emergencyMinMinutes * MIN < from) return null;
  const dev = sustainedDeviation(input, quiet, steps);
  if (dev === null) return null;
  // Never warm the room while asleep (unless the profile allows it): a room that is too cold waits for the morning.
  if (dev < 0 && !quiet.emergencyWarm) return null;
  // Still cooling (too warm and falling ≥ STILL_MOVING_C_PER_H over the last TREND_WINDOW_MIN): the AC is working; wait.
  // 2026-10-31: 21.7 → 21.3 °C in 30 min under Cool 17 still fired "set 16", and the unit stopped cooling.
  if (stillConverging(input.recent, now, dev > 0)) return null;
  // A planned step due within the grace window that moves toward the room (cooler when it is too warm) will fix it:
  // wait for it instead of beeping twice.
  if (nextStep && nextStep.ts - now <= STEP_GRACE_MIN * MIN && Math.sign(nextStep.targetC - heldTarget(input, steps, now)!) === -Math.sign(dev)) return null;
  const delta = clamp(-Math.round(dev), -2, 2);
  const sp = clamp(cur.setpointC + delta, lo, hi);
  const cmd = makeCommand(
    now,
    { power: true, setpointC: sp, mode: 'cool', fan: cur.fan },
    remote,
    `emergency: room ${Math.abs(dev).toFixed(1)}° ${dev > 0 ? 'above' : 'below'} target for ${quiet.emergencyMinMinutes}+ min (set ${sp})`,
  );
  if (!cmd || sameState(cur, cmd.state) || (lastCommand.button !== undefined && cmd.button === lastCommand.button)) return null;
  // Only strictly colder than the last command for a too-warm room (strictly warmer for an allowed warming one): at the
  // SETALL_MIN_C floor (17) there is no colder setpoint, so no IR frame and no beep (the evening acUnresponsive push
  // is the only alert path). Checked on the state actually sent (a ladder button may map elsewhere).
  if (dev > 0 ? cmd.state.setpointC >= cur.setpointC : cmd.state.setpointC <= cur.setpointC) return null;
  return cmd;
}

export interface AcUnresponsive {
  /** Room (last 5 min) and the target it should be heading for. */
  roomC: number;
  targetC: number;
  /** First command of the unanswered streak. */
  since: Ms;
  /** Power-on commands in a row that the room did not respond to. */
  commands: number;
}

/**
 * The AC seems to ignore us: at least two power-on commands in a row without a confirmed landing, the last one
 * ≥ UNRESPONSIVE_AFTER_MIN old, and the room still far above target and not cooling. Resends cannot fix a wrong IR
 * template or a missed receiver; ac-curve tells the household (push) once per night,
 * and only before the expected sleep onset, so an alert never wakes anyone.
 */
export function acUnresponsive(input: ControllerInput): AcUnresponsive | null {
  const curve = usesSleepOnset(input.curve) ? resolveCurve(input.curve, input.lightsOut, input.sleepOnset) : input.curve;
  const { now, lastCommand, recent, lightsOut } = input;
  if (!lastCommand?.state.power || lastCommand.landed === true) return null;
  // A phone alert must not wake anyone: only while people are still awake.
  if (now >= awakeUntil(input)) return null;
  if (now - lastCommand.ts < UNRESPONSIVE_AFTER_MIN * MIN - INTERVAL_SLACK_MS) return null;
  const target = targetAt(curve, lightsOut, now);
  if (target === null) return null;
  const above = stalledAbove(recent, now, target);
  if (above === null) return null;
  let commands = 1;
  let since = lastCommand.ts;
  const earlier = (input.tonight ?? []).filter((c) => c.ts < lastCommand.ts);
  for (let i = earlier.length - 1; i >= 0; i--) {
    const c = earlier[i]!;
    if (!c.state.power || c.landed === true) break;
    commands++;
    since = c.ts;
  }
  return commands >= 2 ? { roomC: target + above, targetC: target, since, commands } : null;
}
