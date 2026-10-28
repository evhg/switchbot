'use client';
import { DEFAULT_CURVE, type CurvePhase, type TemperatureCurve } from '@sleep-lab/core';
import { usePref } from './prefs.ts';

export const PHASE_LABEL: Record<CurvePhase['name'], string> = {
  precool: 'Pre-cool',
  onset: 'Falling asleep',
  deep: 'Deep window',
  middle: 'Middle (ramp)',
  late: 'Late / REM',
  wake: 'Wake',
};

function valid(c: unknown): c is TemperatureCurve {
  if (!c || typeof c !== 'object') return false;
  const x = c as TemperatureCurve;
  return (
    Array.isArray(x.phases) &&
    x.phases.length === DEFAULT_CURVE.phases.length &&
    x.phases.every((p, i) => p.name === DEFAULT_CURVE.phases[i]!.name && Number.isFinite(p.startMin) && Number.isFinite(p.targetC))
  );
}

/** Keep phases ordered and inside the safety limits. */
export function sanitizeCurve(c: TemperatureCurve): TemperatureCurve {
  const phases = c.phases.map((p) => ({ ...p, targetC: Math.round(Math.min(c.maxC, Math.max(c.minC, p.targetC)) * 2) / 2 }));
  for (let i = 1; i < phases.length; i++) phases[i]!.startMin = Math.max(phases[i]!.startMin, phases[i - 1]!.startMin + 10);
  return { ...c, phases };
}

export function usePlannedCurve(): [TemperatureCurve, (c: TemperatureCurve) => void, () => void] {
  const [stored, setStored] = usePref<TemperatureCurve | null>('curve', null);
  const curve = valid(stored) ? stored : DEFAULT_CURVE;
  return [curve, (c) => setStored(sanitizeCurve({ ...c, id: 'custom', name: 'My curve' })), () => setStored(null)];
}
