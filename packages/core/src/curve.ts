import type { Ms, TemperatureCurve } from './types.ts';

const MIN = 60_000;

/** Expected sleep onset when a night does not say: lights-out + 60 min (bed at 22:00, asleep around 23:00). */
export const DEFAULT_SLEEP_ONSET_MIN = 60;
/** Sleep onset is clamped to lights-out … lights-out + 3 h (a phase never moves before lights-out). */
export const MAX_SLEEP_ONSET_MIN = 180;

/**
 * "One beep per night", anchored to sleep onset (default since 2026-10-30). Same shape as one-beep-v1, but the sleep
 * phases count from the night's expected sleep onset instead of lights-out: they get into bed at 22:00 and fall
 * asleep around 23:00, and the deep window and the warming step belong to sleep, not to bedtime.
 *   precool  −30 min from lights-out  19 °C   ON (set 18) at 21:30, the only evening command
 *   onset      0     from lights-out  19 °C   same target and fan → no command at lights-out
 *   deep     +30     from sleep onset 19 °C   coolest stretch for the first sleep cycles (23:30 for a 23:00 onset);
 *                                             same target → no command at sleep onset either
 *   middle   +270    from sleep onset 21 °C   THE warming step, onset + 4 h 30 (03:30): one command while asleep
 *   late     +360    from sleep onset 21 °C   same target → no command
 *   wake     +570    from sleep onset 21 °C   (08:30 for a 23:00 onset) same target → no command; OFF at wake + 30
 * Setpoints with the default bias −1: 18 → 20. Why +4 h 30 and 21 °C: see ONE_BEEP_V1 (RESEARCH.md §6).
 */
export const DEFAULT_CURVE: TemperatureCurve = {
  id: 'one-beep-v2',
  name: 'One beep, from sleep onset (default)',
  minC: 17,
  maxC: 24,
  phases: [
    { name: 'precool', startMin: -30, targetC: 19, fan: 'auto' },
    { name: 'onset', startMin: 0, targetC: 19, fan: 'auto' },
    { name: 'deep', startMin: 30, targetC: 19, fan: 'auto', anchor: 'sleepOnset' },
    { name: 'middle', startMin: 270, targetC: 21, fan: 'auto', anchor: 'sleepOnset' },
    { name: 'late', startMin: 360, targetC: 21, fan: 'auto', anchor: 'sleepOnset' },
    { name: 'wake', startMin: 570, targetC: 21, fan: 'auto', anchor: 'sleepOnset' },
  ],
};

/**
 * "One beep per night" (docs/RESEARCH.md §6, default 2026-10-29 → 30; nights stored with 'one-beep-v1' keep it). The
 * aircon's IR receiver beeps on every command, so while asleep the plan sends exactly ONE command, the warming step.
 * Every phase counts from lights-out:
 *   precool  −30 min  19 °C   the only evening command: the room is already cold at lights-out (no command then)
 *   onset      0      19 °C   same target and fan as precool → no command at lights-out
 *   deep     +30      19 °C   coolest stretch for the first sleep cycles (RESEARCH: 18.5–20 °C, +0.5 → +4 h)
 *   middle   +270     21 °C   THE warming step, +4 h 30. One step instead of the +0.5 °C/h ramp: the deep window
 *                             (+0.5 → +4 h) is over, and the ducted unit plus the room's thermal mass take roughly an
 *                             hour to bring the bed-height air up ~2 °C, so the room arrives at ~21 °C around +5.5 to
 *                             +6 h, right when the REM-heavy late night starts (+6 h). 21 °C is the low end of the
 *                             21–22 °C late target: RESEARCH warns that warming too much caused awakenings.
 *   late     +360     21 °C   same target → no command
 *   wake     +510     21 °C   (06:30 for a 22:00 lights-out) same target → no command; OFF at wake + 30 min
 * Fan 'auto' in every phase: it runs fast while the room pulls down and backs off near the setpoint, and with one
 * fan speed all night no phase boundary is a fan-only command. Setpoints with the default bias −1: 18 → 20.
 */
export const ONE_BEEP_V1: TemperatureCurve = {
  id: 'one-beep-v1',
  name: 'One beep (v1, from lights-out)',
  minC: 17,
  maxC: 24,
  phases: [
    { name: 'precool', startMin: -30, targetC: 19, fan: 'auto' },
    { name: 'onset', startMin: 0, targetC: 19, fan: 'auto' },
    { name: 'deep', startMin: 30, targetC: 19, fan: 'auto' },
    { name: 'middle', startMin: 270, targetC: 21, fan: 'auto' },
    { name: 'late', startMin: 360, targetC: 21, fan: 'auto' },
    { name: 'wake', startMin: 510, targetC: 21, fan: 'auto' },
  ],
};

/**
 * The previous default (until 2026-10-29): pre-cool 90 min early, 3 commands while asleep in quiet mode. Kept for
 * nights stored with curve_id 'default-v1' and for the tests of ramped phases.
 */
export const CURVE_V1: TemperatureCurve = {
  id: 'default-v1',
  name: 'Cool & deep (v1)',
  minC: 17,
  maxC: 24,
  phases: [
    { name: 'precool', startMin: -90, targetC: 20.5 },
    { name: 'onset', startMin: 0, targetC: 20 },
    { name: 'deep', startMin: 40, targetC: 19 },
    { name: 'middle', startMin: 240, targetC: 19, ramp: true },
    { name: 'late', startMin: 360, targetC: 21.5 },
    { name: 'wake', startMin: 450, targetC: 22 },
  ],
};

/** Built-in curves by id (a stored night's curve_id), for readers without the curves table. */
export const BUILTIN_CURVES: readonly TemperatureCurve[] = [DEFAULT_CURVE, ONE_BEEP_V1, CURVE_V1];

/** Does any phase count from sleep onset? */
export function usesSleepOnset(curve: TemperatureCurve): boolean {
  return curve.phases.some((p) => p.anchor === 'sleepOnset');
}

/** Minutes from lights-out to the expected sleep onset: `sleepOnset` (default lights-out + 60), clamped to 0 … 180. */
export function sleepOnsetOffsetMin(lightsOut: Ms, sleepOnset?: Ms | null): number {
  const m = sleepOnset === undefined || sleepOnset === null || !Number.isFinite(sleepOnset) ? DEFAULT_SLEEP_ONSET_MIN : (sleepOnset - lightsOut) / MIN;
  return Math.min(MAX_SLEEP_ONSET_MIN, Math.max(0, Math.round(m)));
}

/** Expected sleep onset (epoch ms) for a night: `sleepOnset` when given (clamped), else lights-out + 60 min. */
export function expectedSleepOnset(lightsOut: Ms, sleepOnset?: Ms | null): Ms {
  return lightsOut + sleepOnsetOffsetMin(lightsOut, sleepOnset) * MIN;
}

/**
 * The curve for one night with every phase counted from lights-out: phases anchored to 'sleepOnset' are moved by the
 * night's onset offset (sleepOnsetOffsetMin) and lose their anchor. A curve without such phases (default-v1,
 * one-beep-v1, custom curves) is returned unchanged, so nights stored with older curves behave exactly as before.
 * The planner, the controller, phaseAt and targetAt all work on the resolved curve.
 */
export function resolveCurve(curve: TemperatureCurve, lightsOut: Ms, sleepOnset?: Ms | null): TemperatureCurve {
  if (!usesSleepOnset(curve)) return curve;
  const off = sleepOnsetOffsetMin(lightsOut, sleepOnset);
  const phases = curve.phases
    .map(({ anchor, ...p }) => (anchor === 'sleepOnset' ? { ...p, startMin: p.startMin + off } : p))
    .sort((a, b) => a.startMin - b.startMin);
  return { ...curve, phases };
}

/**
 * Inverse of resolveCurve for an edited copy: `resolved` has lights-out minutes (e.g. from a curve editor); phases
 * that are anchored to sleep onset in `template` get their anchor back and lose the offset.
 */
export function anchorCurve(resolved: TemperatureCurve, template: TemperatureCurve, offsetMin: number): TemperatureCurve {
  if (!usesSleepOnset(template)) return resolved;
  return {
    ...resolved,
    phases: resolved.phases.map((p) => {
      const anchor = template.phases.find((t) => t.name === p.name)?.anchor;
      return anchor === 'sleepOnset' ? { ...p, startMin: p.startMin - offsetMin, anchor } : p;
    }),
  };
}

/** Phase active at `ts`, or null before the first phase starts. `sleepOnset` matters only for onset-anchored curves. */
export function phaseAt(input: TemperatureCurve, lightsOut: Ms, ts: Ms, sleepOnset?: Ms | null) {
  const curve = resolveCurve(input, lightsOut, sleepOnset);
  const m = (ts - lightsOut) / MIN;
  let idx = -1;
  for (let i = 0; i < curve.phases.length; i++) {
    if (curve.phases[i]!.startMin <= m) idx = i;
  }
  return idx === -1 ? null : { phase: curve.phases[idx]!, index: idx };
}

/**
 * Target room temperature (°C) at `ts` for a night whose lights-out is `lightsOut` (and expected sleep onset
 * `sleepOnset`, default lights-out + 60, for onset-anchored curves).
 * Before the first phase: null (curve not active). Ramped phases interpolate to the next phase's target.
 */
export function targetAt(input: TemperatureCurve, lightsOut: Ms, ts: Ms, sleepOnset?: Ms | null): number | null {
  const curve = resolveCurve(input, lightsOut, sleepOnset);
  const hit = phaseAt(curve, lightsOut, ts);
  if (!hit) return null;
  const { phase, index } = hit;
  const next = curve.phases[index + 1];
  let t = phase.targetC;
  if (phase.ramp && next) {
    const m = (ts - lightsOut) / MIN;
    const f = Math.min(1, Math.max(0, (m - phase.startMin) / (next.startMin - phase.startMin)));
    t = phase.targetC + f * (next.targetC - phase.targetC);
  }
  return Math.min(curve.maxC, Math.max(curve.minC, t));
}
