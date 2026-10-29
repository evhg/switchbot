import type { Ms, TemperatureCurve } from './types.ts';

const MIN = 60_000;

/**
 * "One beep per night" (docs/RESEARCH.md §6, decided 2026-10-29). The aircon's IR receiver beeps on every command, so
 * while asleep the plan sends exactly ONE command, the warming step:
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
export const DEFAULT_CURVE: TemperatureCurve = {
  id: 'one-beep-v1',
  name: 'One beep (default)',
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

/** Phase active at `ts`, or null before the first phase starts. */
export function phaseAt(curve: TemperatureCurve, lightsOut: Ms, ts: Ms) {
  const m = (ts - lightsOut) / MIN;
  let idx = -1;
  for (let i = 0; i < curve.phases.length; i++) {
    if (curve.phases[i]!.startMin <= m) idx = i;
  }
  return idx === -1 ? null : { phase: curve.phases[idx]!, index: idx };
}

/**
 * Target room temperature (°C) at `ts` for a night whose lights-out is `lightsOut`.
 * Before the first phase: null (curve not active). Ramped phases interpolate to the next phase's target.
 */
export function targetAt(curve: TemperatureCurve, lightsOut: Ms, ts: Ms): number | null {
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
