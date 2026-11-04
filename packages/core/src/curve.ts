import type { Ms, TemperatureCurve } from './types.ts';

const MIN = 60_000;

/** Expected sleep onset when a night does not say: lights-out + 60 min (bed at 22:00, asleep around 23:00). */
export const DEFAULT_SLEEP_ONSET_MIN = 60;
/** Sleep onset is clamped to lights-out … lights-out + 3 h (a phase never moves before lights-out). */
export const MAX_SLEEP_ONSET_MIN = 180;

/**
 * "Steady 18.5, quiet fan" (default since 2026-11-02). Same targets as steady-18-5-v1, but the fan drops from auto to
 * low half an hour after lights-out: on 2026-11-01 the household could not fall asleep with the auto fan running
 * (too loud). The pre-cool keeps fan auto for a fast pull-down before bed.
 *   precool  −30 min from lights-out  18.5 °C   ON at 21:30, fan auto (fast pull-down)
 *   onset      0                      18.5 °C   same target and fan → no command at lights-out
 *   deep     +30                      18.5 °C   fan low: the ONE command after lights-out (22:30), fan only, same setpoint
 *   middle   +270                     18.5 °C   same target and fan → no command while asleep
 *   late     +360                     18.5 °C   same → no command
 *   wake     +630                     18.5 °C   (08:30 for a 22:00 lights-out) same → no command; OFF at wake + 30
 * With the bias −2 and the learned "Others" ladder: 21:30 "17 cool auto", 22:30 "cool 17 low", 09:00 "off".
 * Every phase counts from lights-out. minC 17: see STEADY_18_5_V1.
 */
export const DEFAULT_CURVE: TemperatureCurve = {
  id: 'steady-18-5-quiet-v1',
  name: 'Steady 18.5 °C, quiet fan (default)',
  minC: 17,
  maxC: 24,
  phases: [
    { name: 'precool', startMin: -30, targetC: 18.5, fan: 'auto' },
    { name: 'onset', startMin: 0, targetC: 18.5, fan: 'auto' },
    { name: 'deep', startMin: 30, targetC: 18.5, fan: 'low' },
    { name: 'middle', startMin: 270, targetC: 18.5, fan: 'low' },
    { name: 'late', startMin: 360, targetC: 18.5, fan: 'low' },
    { name: 'wake', startMin: 630, targetC: 18.5, fan: 'low' },
  ],
};

/**
 * "Steady 18.5" (default 2026-10-30 evening → 2026-11-02; nights stored with 'steady-18-5-v1' keep it). The household prefers ~18.5 °C (Walker: ~18 °C) and does not want
 * the room to warm while either of them may still be in deep sleep. The watches' sleep stages are not available live
 * during the night, so the controller cannot know when deep sleep is over: the curve is flat instead of warming.
 *   precool  −30 min from lights-out  18.5 °C   ON at 21:30 (fan auto), the only evening command
 *   onset      0                      18.5 °C   same target and fan → no command at lights-out
 *   deep     +30                      18.5 °C   same → no command
 *   middle   +270                     18.5 °C   same → no warming step: NO command while asleep
 *   late     +360                     18.5 °C   same → no command
 *   wake     +630                     18.5 °C   (08:30 for a 22:00 lights-out) same → no command; OFF at wake + 30
 * Every phase counts from lights-out (nothing to anchor to sleep onset: nothing changes during sleep).
 * Setpoint = round(18.5 + bias): 17 with the bias −2 measured on the first real night (set 17 → bed 18.5–19.9 °C), 18
 * with the untuned default −1. minC 17: the aircon's IR remote (Carrier 42TGF, Toshiba protocol) encodes 17–30 only
 * (SETALL_MIN_C), so 17 is the coldest setpoint there is. With bias −2 the plan already sits on that floor and the
 * emergency correction (cooling only while asleep, see QuietConfig) has no colder setpoint left: it sends nothing.
 * (Until 2026-11-01 minC was 16 so an emergency could go one degree below 17; a 16 never reached the unit.)
 */
export const STEADY_18_5_V1: TemperatureCurve = {
  id: 'steady-18-5-v1',
  name: 'Steady 18.5 °C (v1, fan auto)',
  minC: 17,
  maxC: 24,
  phases: [
    { name: 'precool', startMin: -30, targetC: 18.5, fan: 'auto' },
    { name: 'onset', startMin: 0, targetC: 18.5, fan: 'auto' },
    { name: 'deep', startMin: 30, targetC: 18.5, fan: 'auto' },
    { name: 'middle', startMin: 270, targetC: 18.5, fan: 'auto' },
    { name: 'late', startMin: 360, targetC: 18.5, fan: 'auto' },
    { name: 'wake', startMin: 630, targetC: 18.5, fan: 'auto' },
  ],
};

/**
 * "One beep per night", anchored to sleep onset (default 2026-10-30 morning → evening; nights stored with
 * 'one-beep-v2' keep it). Same shape as one-beep-v1, but the sleep
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
export const ONE_BEEP_V2: TemperatureCurve = {
  id: 'one-beep-v2',
  name: 'One beep, from sleep onset (v2)',
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

/**
 * Experiment variants (2026-11-04, Lab › Experiments, migration 0025). Each one has the default's shape: pre-cool on fan
 * auto at −30, fan low from +30, every phase from lights-out, minC 17 (the IR floor), so the controller's safety rules
 * apply unchanged: setpoint never below 17, at most the planned steps + one extra while asleep, an emergency only cools,
 * and a same-target step never warms (controller: "dir === 0 … sp > cur.setpointC"). A PLANNED warming step while asleep
 * is allowed by the controller (one-beep-v1/v2 have one); the household's rule "don't warm while someone may be in deep
 * sleep" is respected by placing that step at lights-out + 300 min (03:00 for a 22:00 lights-out), after the deep-sleep
 * window (+30 → +4 h). Each variant adds at most ONE command while asleep (one beep), never more than one-beep-v1.
 */

/** "Steady 19.5, quiet fan": the default one degree warmer all night. Same commands (no step while asleep but the
 * fan-only 22:30 one); setpoint round(19.5 + bias) = 18 with bias −2. */
export const STEADY_19_5_QUIET_V1: TemperatureCurve = {
  id: 'steady-19-5-quiet-v1',
  name: 'Steady 19.5 °C, quiet fan',
  minC: 17,
  maxC: 24,
  phases: [
    { name: 'precool', startMin: -30, targetC: 19.5, fan: 'auto' },
    { name: 'onset', startMin: 0, targetC: 19.5, fan: 'auto' },
    { name: 'deep', startMin: 30, targetC: 19.5, fan: 'low' },
    { name: 'middle', startMin: 270, targetC: 19.5, fan: 'low' },
    { name: 'late', startMin: 360, targetC: 19.5, fan: 'low' },
    { name: 'wake', startMin: 630, targetC: 19.5, fan: 'low' },
  ],
};

/** "18.5, then 19.5 late": the default until lights-out + 300 (03:00), then one warming step to 19.5 for the
 * REM-heavy late night. One planned command while asleep after the fan-only one (with bias −2: 17 → 18). */
export const WARM_LATE_19_5_QUIET_V1: TemperatureCurve = {
  id: 'warm-late-19-5-quiet-v1',
  name: '18.5 °C, 19.5 °C from 03:00 (quiet fan)',
  minC: 17,
  maxC: 24,
  phases: [
    { name: 'precool', startMin: -30, targetC: 18.5, fan: 'auto' },
    { name: 'onset', startMin: 0, targetC: 18.5, fan: 'auto' },
    { name: 'deep', startMin: 30, targetC: 18.5, fan: 'low' },
    { name: 'middle', startMin: 300, targetC: 19.5, fan: 'low' },
    { name: 'late', startMin: 360, targetC: 19.5, fan: 'low' },
    { name: 'wake', startMin: 630, targetC: 19.5, fan: 'low' },
  ],
};

/** "Cool early, warm late": 18 °C for the deep-sleep half of the night, 19.5 °C from lights-out + 300 (03:00). With
 * bias −2 the early setpoint sits on the 17 floor (as the default does), the late one is 18. */
export const COOL_EARLY_WARM_LATE_V1: TemperatureCurve = {
  id: 'cool-early-warm-late-v1',
  name: '18 °C early, 19.5 °C from 03:00 (quiet fan)',
  minC: 17,
  maxC: 24,
  phases: [
    { name: 'precool', startMin: -30, targetC: 18, fan: 'auto' },
    { name: 'onset', startMin: 0, targetC: 18, fan: 'auto' },
    { name: 'deep', startMin: 30, targetC: 18, fan: 'low' },
    { name: 'middle', startMin: 300, targetC: 19.5, fan: 'low' },
    { name: 'late', startMin: 360, targetC: 19.5, fan: 'low' },
    { name: 'wake', startMin: 630, targetC: 19.5, fan: 'low' },
  ],
};

/** The aircon variants experiments may assign (besides the default), in Autopilot's testing order. */
export const EXPERIMENT_CURVES: readonly TemperatureCurve[] = [WARM_LATE_19_5_QUIET_V1, STEADY_19_5_QUIET_V1, COOL_EARLY_WARM_LATE_V1];

/**
 * The yardstick for a night run by hand (Night.manual): no plan ran, so the room is scored against the household's
 * steady comfort target instead of the stored curve. Flat at DEFAULT_CURVE's target (18.5 °C), so "in target" means
 * within ±0.75 °C of it (17.75–19.25 °C) all night, and steadiness is the spread around the night's own mean error.
 */
export const MANUAL_COMFORT_TARGET_C = 18.5;

export function manualComfortCurve(targetC = MANUAL_COMFORT_TARGET_C): TemperatureCurve {
  return {
    id: 'manual-comfort',
    name: `Comfort ${targetC} °C (aircon by hand)`,
    minC: 16,
    maxC: 24,
    phases: [{ name: 'onset', startMin: 0, targetC }],
  };
}

/** The curve a night's room is scored against: the stored plan, or the comfort target when it ran by hand. */
export function scoringCurve(night: { manual?: boolean }, curve: TemperatureCurve): TemperatureCurve {
  return night.manual === true ? manualComfortCurve() : curve;
}

/** Built-in curves by id (a stored night's curve_id), for readers without the curves table. */
export const BUILTIN_CURVES: readonly TemperatureCurve[] = [DEFAULT_CURVE, STEADY_18_5_V1, ONE_BEEP_V2, ONE_BEEP_V1, CURVE_V1, ...EXPERIMENT_CURVES];

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
