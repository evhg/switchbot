import type { Ms, TemperatureCurve } from './types.ts';

const MIN = 60_000;

/**
 * Starting curve from docs/RESEARCH.md §6 (room air at bed height):
 * pre-cool → onset 20 → deep 19 (coolest, first ~4 h) → ramp → late 21.5 → wake.
 */
export const DEFAULT_CURVE: TemperatureCurve = {
  id: 'default-v1',
  name: 'Cool & deep (default)',
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
