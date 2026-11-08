'use client';
import { DEFAULT_CURVE, type CurvePhase, type TemperatureCurve } from '@sleep-lab/core';
import { useEffect, useMemo, useState } from 'react';
import { useData } from './data/context.tsx';
import { curveById, fetchNightCurveId } from './data/supabase.ts';
import { usePref } from './prefs.ts';
import { tonightDate } from './tonight.ts';

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

/**
 * Keep phases ordered and inside the safety limits. Phases count from lights out or (anchor 'sleepOnset') from sleep
 * onset; order is only enforced between phases that count from the same anchor (the editor works on the resolved
 * curve, where every phase counts from lights out, and orders it there).
 */
export function sanitizeCurve(c: TemperatureCurve): TemperatureCurve {
  const phases = c.phases.map((p) => ({ ...p, targetC: Math.round(Math.min(c.maxC, Math.max(c.minC, p.targetC)) * 2) / 2 }));
  for (let i = 1; i < phases.length; i++) {
    const prev = phases[i - 1]!;
    if ((prev.anchor ?? 'lightsOut') === (phases[i]!.anchor ?? 'lightsOut')) phases[i]!.startMin = Math.max(phases[i]!.startMin, prev.startMin + 10);
  }
  return { ...c, phases };
}

export function usePlannedCurve(): [TemperatureCurve, (c: TemperatureCurve) => void, () => void] {
  const [stored, setStored] = usePref<TemperatureCurve | null>('curve', null);
  const curve = valid(stored) ? stored : DEFAULT_CURVE;
  return [curve, (c) => setStored(sanitizeCurve({ ...c, id: 'custom', name: 'My curve' })), () => setStored(null)];
}

export interface TonightCurve {
  /** The curve tonight runs: the household's (nights.curve_id) on real data, else this device's planned curve. */
  curve: TemperatureCurve;
  /** Real data: tonight's curve comes from the backend and edits here are a preview only. */
  live: boolean;
  /** Real data and the nights row hasn't been read yet. */
  loading: boolean;
}

/**
 * Tonight's plan, the same way Today tells it: on real data the curve on tonight's nights row (the backend's default
 * when there is no row yet), resolved against the household's curves; otherwise the curve planned on this device.
 * There is no RPC to store a custom curve, so on real data the editor's changes stay a preview on this device.
 */
export function useTonightCurve(): TonightCurve {
  const { latest, dataset, sourceKind } = useData();
  const [local] = usePlannedCurve();
  const live = sourceKind === 'supabase';
  const [id, setId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!live) return setId(undefined);
    let alive = true;
    fetchNightCurveId(tonightDate()).then(
      (x) => alive && setId(x),
      () => alive && setId(null),
    );
    return () => {
      alive = false;
    };
  }, [live]);
  const curves = (latest ?? dataset)?.curves;
  const real = useMemo(() => curveById(id ?? null, curves), [id, curves]);
  return live ? { curve: real, live, loading: id === undefined } : { curve: local, live, loading: false };
}
