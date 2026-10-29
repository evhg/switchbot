import type { AcState, CurvePhaseName, FanSpeed, Ms, TemperatureCurve } from '../types.ts';
import { expectedSleepOnset, phaseAt, resolveCurve, targetAt } from '../curve.ts';
import { remoteCommand, resolveQuiet, type RemoteProfile, type ResolvedQuiet } from './remote.ts';

const MIN = 60_000;
/** Assumed bed-minus-setpoint offset before anything is learned (bias −1). Same default as the controller. */
export const DEFAULT_BIAS_C = -1;
/** The aircon is switched off this long after wake. */
export const OFF_AFTER_WAKE_MIN = 30;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** A planned quiet-mode step while asleep: the moment and the room target it moves the setpoint to. */
export interface QuietStep {
  ts: Ms;
  targetC: number;
  phase: CurvePhaseName;
  kind: 'phase' | 'ramp';
}

/** Start of "asleep" for quiet mode: lights-out + the settle window. */
export function asleepFrom(lightsOut: Ms, quiet: ResolvedQuiet): Ms {
  return lightsOut + quiet.settleMin * MIN;
}

/**
 * The only moments quiet mode moves the setpoint from lights-out until the OFF at wake + 30 min: the start of each
 * non-ramped phase, and one step per ramped phase (see QuietConfig.rampStrategy). Steps inside the settle window
 * (lights-out → lights-out + settle) are included: before `asleepFrom` the closed loop usually sends them on time, but
 * one blocked by minInterval (e.g. a phase 10 min after the onset command) is carried into quiet mode as a planned step.
 */
export function quietSteps(curve: TemperatureCurve, lightsOut: Ms, wake: Ms, quiet: ResolvedQuiet): QuietStep[] {
  const out: QuietStep[] = [];
  curve.phases.forEach((p, i) => {
    const next = curve.phases[i + 1];
    let ts: Ms;
    let aimAt: Ms;
    let kind: QuietStep['kind'] = 'phase';
    if (p.ramp && next) {
      if (quiet.rampStrategy === 'end') return;
      const span = next.startMin - p.startMin;
      const [at, aim] = quiet.rampStrategy === 'midpoint' ? [span / 2, span / 2] : [span / 3, (2 * span) / 3];
      ts = lightsOut + (p.startMin + at) * MIN;
      aimAt = lightsOut + (p.startMin + aim) * MIN;
      kind = 'ramp';
    } else {
      ts = lightsOut + p.startMin * MIN;
      aimAt = ts;
    }
    if (ts < lightsOut || ts >= wake + OFF_AFTER_WAKE_MIN * MIN) return;
    const t = targetAt(curve, lightsOut, aimAt);
    if (t === null) return;
    out.push({ ts, targetC: Math.round(t * 10) / 10, phase: p.name, kind });
  });
  return out.sort((a, b) => a.ts - b.ts);
}

/** Quiet mode sends a planned step until this long after it is due (or after asleepFrom, for a step in the settle window). */
export const STEP_GRACE_MIN = 30;
export function stepDeadline(step: QuietStep, from: Ms): Ms {
  return Math.max(step.ts, from) + STEP_GRACE_MIN * MIN;
}

/**
 * The whole-degree bias (setpoint − target) a command was sent with, recovered exactly from its setpoint and the target
 * it aimed for: sp = round(target + b) ⇔ b ∈ [sp − 0.5 − target, sp + 0.5 − target), one integer. A setpoint at a
 * limit (clamped) only bounds b, so it is combined with `prior` there. Lets the controller carry its bias between
 * stateless calls without the ±0.5 rounding ambiguity of "target − setpoint".
 */
export function recoverBias(sp: number, targetC: number, limits: { lo: number; hi: number }, prior: number, maxAbs = 2): number {
  const b = Math.ceil(sp - 0.5 - targetC - 1e-6);
  const out = sp <= limits.lo ? Math.min(b, prior) : sp >= limits.hi ? Math.max(b, prior) : b;
  return clamp(out, -maxAbs, maxAbs);
}

/**
 * A settle-window step (before asleepFrom) the closed loop could not send in time is carried into quiet mode, unless
 * the next step is due within STEP_GRACE_MIN of `at`: that one carries the change, one beep instead of two.
 */
export function carriedStepSuperseded(step: { ts: Ms }, next: { ts: Ms } | undefined, at: Ms, from: Ms): boolean {
  return step.ts < from && at >= from && next !== undefined && next.ts - at <= STEP_GRACE_MIN * MIN;
}

/** Setpoint limits: curve minC/maxC (hard safety limits) within the remote's 16–30. */
export function setpointLimits(curve: TemperatureCurve): { lo: number; hi: number } {
  return { lo: Math.max(16, Math.ceil(curve.minC)), hi: Math.min(30, Math.floor(curve.maxC)) };
}

/** Fan for a phase: 'auto' for a learned ladder; else the curve phase's own `fan`, else high for precool and low after. */
export function fanFor(remote: RemoteProfile, phase: CurvePhaseName, curve?: TemperatureCurve): FanSpeed {
  if (remote.kind === 'customize') return 'auto';
  const own = curve?.phases.find((p) => p.name === phase)?.fan;
  if (own) return own;
  return phase === 'precool' ? 'high' : 'low';
}

export interface PlannedAcCommand {
  ts: Ms;
  /** The state sent (for a ladder remote: the learned button's state). */
  state: AcState;
  button?: string;
  /** Room target at bed height the command aims for (null for OFF). */
  targetC: number | null;
  phase: CurvePhaseName | 'off';
  kind: 'on' | 'phase' | 'ramp' | 'off';
  reason: string;
  /** Sent between lights-out + settle and wake: the receiver's beep can wake someone. */
  asleep: boolean;
}

export interface AcPlan {
  quiet: boolean;
  commands: PlannedAcCommand[];
  /** Commands (= beeps) planned while asleep. */
  asleepCount: number;
  total: number;
  /** Extra commands quiet mode may still send while asleep (an emergency or a resend, shared budget); null when quiet is off. */
  maxExtraAsleep: number | null;
  asleepFrom: Ms;
  /** Expected sleep onset the sleep phases were anchored to (onset-anchored curves; lights-out + 60 min by default). */
  sleepOnset: Ms;
}

export interface PlanInput {
  curve: TemperatureCurve;
  lightsOut: Ms;
  wake: Ms;
  remote: RemoteProfile;
  /** Setpoint − bed target; default −1 (bed reads ~1 °C above return air). */
  biasC?: number;
  /** Expected sleep onset (onset-anchored curves only); default lights-out + 60 min. Pass the controller the same. */
  sleepOnset?: Ms;
}

/**
 * The command schedule the controller plans for a night, assuming the room follows the setpoint (no misses,
 * no emergencies, a constant bias: `biasC`, else −1, the same rounding as the controller). Before lights-out: precool
 * and each phase start; from lights-out: the quiet steps (quiet on) or each phase start and every whole-degree change
 * of the rounded target (quiet off; real nights add corrections); OFF at wake + 30 min. Commands that would not change
 * the state are skipped and each command waits for minInterval after the previous one, as the controller does.
 * Quiet mode guarantees the number of planned commands while asleep: a re-measured bias may move a step's setpoint
 * by 1 °C but never adds a step the plan skips (see decideAcCommand).
 */
export function planAcSchedule(input: PlanInput): AcPlan {
  const { lightsOut, wake, remote } = input;
  const curve = resolveCurve(input.curve, lightsOut, input.sleepOnset);
  const quiet = resolveQuiet(remote);
  const bias = clamp(Math.round(input.biasC ?? DEFAULT_BIAS_C), -2, 2);
  const { lo, hi } = setpointLimits(curve);
  const from = asleepFrom(lightsOut, quiet);
  const onFrom = lightsOut + Math.min(0, curve.phases[0]?.startMin ?? 0) * MIN;
  const offAt = wake + OFF_AFTER_WAKE_MIN * MIN;
  const out: PlannedAcCommand[] = [];
  let cur: AcState | null = null;
  let curButton: string | undefined;

  const push = (ts: Ms, targetC: number, phase: CurvePhaseName, kind: PlannedAcCommand['kind'], label: string) => {
    const sp = clamp(Math.round(targetC + bias), lo, hi);
    const cmd = remoteCommand(ts, { power: true, setpointC: sp, mode: 'cool', fan: fanFor(remote, phase, curve) }, remote, label);
    if (!cmd) return;
    if (cur && cur.power && cur.setpointC === cmd.state.setpointC && cur.fan === cmd.state.fan && cur.mode === cmd.state.mode) return;
    if (cmd.button !== undefined && cmd.button === curButton) return;
    cur = cmd.state;
    curButton = cmd.button;
    out.push({
      ts,
      state: cmd.state,
      ...(cmd.button ? { button: cmd.button } : {}),
      targetC: Math.round(targetC * 10) / 10,
      phase,
      kind,
      reason: label,
      asleep: ts >= from && ts < wake,
    });
  };

  // Every phase start (quiet on: only those before lights-out; from lights-out the quiet steps below).
  const boundaries = curve.phases
    .map((p) => ({ p, ts: lightsOut + p.startMin * MIN }))
    .filter(({ ts }) => ts >= onFrom && ts < offAt);
  const steps: { ts: Ms; targetC: number; phase: CurvePhaseName; kind: PlannedAcCommand['kind']; label: string }[] = [];
  for (const { p, ts } of boundaries) {
    if (quiet.enabled && ts >= lightsOut) continue;
    const t = targetAt(curve, lightsOut, ts);
    if (t === null) continue;
    steps.push({ ts, targetC: t, phase: p.name, kind: 'phase', label: `${p.name} start` });
  }
  if (quiet.enabled) {
    for (const s of quietSteps(curve, lightsOut, wake, quiet)) {
      steps.push({ ts: s.ts, targetC: s.targetC, phase: s.phase, kind: s.kind, label: s.kind === 'ramp' ? `${s.phase} ramp, one step` : `${s.phase} start` });
    }
  } else {
    // Closed loop: a ramp is followed in whole-degree setpoint steps, at most one per minInterval.
    curve.phases.forEach((p, i) => {
      const next = curve.phases[i + 1];
      if (!p.ramp || !next) return;
      let lastSp = clamp(Math.round(p.targetC + bias), lo, hi);
      let lastTs = -Infinity;
      for (let m = p.startMin + 1; m < next.startMin; m++) {
        const ts = lightsOut + m * MIN;
        if (ts < onFrom || ts >= offAt) continue;
        const t = targetAt(curve, lightsOut, ts)!;
        const sp = clamp(Math.round(t + bias), lo, hi);
        if (sp !== lastSp && ts - lastTs >= remote.minIntervalMin * MIN) {
          steps.push({ ts, targetC: t, phase: p.name, kind: 'ramp', label: `${p.name} ramp step` });
          lastSp = sp;
          lastTs = ts;
        }
      }
    });
  }
  steps.sort((a, b) => a.ts - b.ts);
  steps.forEach((s, i) => {
    // Each command waits for minInterval after the previous one, as in the controller.
    const prevTs = out.at(-1)?.ts;
    const ts = prevTs !== undefined && s.ts - prevTs < remote.minIntervalMin * MIN ? prevTs + remote.minIntervalMin * MIN : s.ts;
    if (quiet.enabled && s.ts >= lightsOut && carriedStepSuperseded(s, steps[i + 1], ts, from)) return;
    push(ts, s.targetC, s.phase, s.kind, s.label);
  });
  if (out[0]) out[0].kind = 'on';

  if (out.length) {
    const last = out[out.length - 1]!;
    const off = remoteCommand(offAt, { power: false, setpointC: last.state.setpointC, mode: 'cool', fan: 'auto' }, remote, 'off, wake + 30 min');
    if (off) {
      out.push({ ts: offAt, state: off.state, ...(off.button ? { button: off.button } : {}), targetC: null, phase: 'off', kind: 'off', reason: off.reason, asleep: false });
    }
  }
  const asleepCount = out.filter((c) => c.asleep).length;
  return {
    quiet: quiet.enabled,
    commands: out,
    asleepCount,
    total: out.length,
    maxExtraAsleep: quiet.enabled ? quiet.maxExtraPerNight : null,
    asleepFrom: from,
    sleepOnset: expectedSleepOnset(lightsOut, input.sleepOnset),
  };
}

/** Phase at `ts`, or 'precool' before the curve starts. */
export function phaseNameAt(curve: TemperatureCurve, lightsOut: Ms, ts: Ms, sleepOnset?: Ms): CurvePhaseName {
  return phaseAt(curve, lightsOut, ts, sleepOnset)?.phase.name ?? 'precool';
}
