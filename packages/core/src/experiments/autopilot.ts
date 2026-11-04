// Autopilot: keeps one aircon experiment going against the default curve and adopts a winner only when it is clearly
// better on the sleep score without more awakenings (pure decision; the experiments Edge Function acts on it).
import { BUILTIN_CURVES } from '../curve.ts';
import { analyzeExperiment, type ExperimentAnalysis } from './analysis.ts';
import { AUTOPILOT_CANDIDATES, AUTOPILOT_MIN_PER_ARM } from './templates.ts';
import type { Experiment, ExperimentArm, ExperimentNight } from './types.ts';

/** A challenger "worsens awakenings" when P(more awakenings than the control) ≥ this, for either person. */
export const AWAKENINGS_WORSE_P = 0.75;

export type AutopilotDecision =
  | { action: 'none'; reason: string }
  | { action: 'start'; curveId: string; reason: string }
  | { action: 'adopt'; arm: string; curveId: string; reason: string }
  | { action: 'finish'; reason: string }
  | { action: 'stop'; reason: string };

export interface AutopilotInput {
  enabled: boolean;
  defaultCurveId: string;
  /** The running auto experiment (Autopilot's or one started by hand), with its nights. */
  running: { exp: Experiment; nights: readonly ExperimentNight[] } | null;
  /**
   * Past Autopilot experiments (to skip candidates already tested against this default). Only 'finished' ones count
   * as tested: a test stopped early (Autopilot switched off) is tried again later. Rows without a status count.
   */
  history: readonly (Pick<Experiment, 'arms' | 'autopilot'> & { status?: Experiment['status'] })[];
  candidates?: readonly string[];
}

const curveName = (id: string) => BUILTIN_CURVES.find((c) => c.id === id)?.name ?? id;

/** People whose awakenings got clearly worse under the leader. */
export function worseAwakenings(a: ExperimentAnalysis): string[] {
  return a.perOutcome.filter((o) => o.key.endsWith('_awakenings') && o.pBetter !== null && 1 - o.pBetter >= AWAKENINGS_WORSE_P).map((o) => o.label);
}

/** The next candidate not yet tested against `defaultCurveId`, or null. */
export function nextCandidate(defaultCurveId: string, history: AutopilotInput['history'], candidates: readonly string[] = AUTOPILOT_CANDIDATES): string | null {
  const tested = new Set(
    history.filter((h) => h.autopilot && (h.status === undefined || h.status === 'finished') && h.arms[0]?.curve_id === defaultCurveId).map((h) => h.arms[1]?.curve_id),
  );
  return candidates.find((c) => c !== defaultCurveId && !tested.has(c)) ?? null;
}

/** Arms of an Autopilot experiment: the default (control) vs the candidate. */
export function autopilotArms(defaultCurveId: string, candidate: string): ExperimentArm[] {
  return [
    { key: defaultCurveId, label: curveName(defaultCurveId), curve_id: defaultCurveId },
    { key: candidate, label: curveName(candidate), curve_id: candidate },
  ];
}

/** Experiment row fields for a new Autopilot experiment. */
export function autopilotExperiment(defaultCurveId: string, candidate: string, startedOn: string, seed: number): Experiment {
  return {
    slug: `autopilot-${candidate}-${startedOn}`,
    title: `Autopilot: ${curveName(candidate)} vs ${curveName(defaultCurveId)}`,
    kind: 'auto',
    arms: autopilotArms(defaultCurveId, candidate),
    primaryOutcome: 'sleep_score',
    status: 'running',
    startedOn,
    seed,
    autopilot: true,
    minPerArm: AUTOPILOT_MIN_PER_ARM,
  };
}

/**
 * One Autopilot step. Off: stop a running Autopilot experiment (an experiment started by hand is left alone).
 * On: a running Autopilot experiment is adopted when the challenger is the clear winner on the sleep score and nobody's
 * awakenings got worse; finished (default kept) when the default wins clearly, the challenger's win costs awakenings, or
 * it ran its maximum nights; otherwise it keeps running. With no aircon experiment running, the next untested candidate
 * starts.
 */
export function autopilotStep(i: AutopilotInput): AutopilotDecision {
  const run = i.running;
  if (!i.enabled) {
    return run?.exp.autopilot ? { action: 'stop', reason: 'Autopilot switched off' } : { action: 'none', reason: 'Autopilot is off' };
  }
  if (run && !run.exp.autopilot) return { action: 'none', reason: `waiting: "${run.exp.title}" is running` };
  if (run) {
    const a = analyzeExperiment(run.exp, run.nights);
    const challenger = run.exp.arms[1]!;
    if (a.status === 'clear_winner' && a.winner === challenger.key) {
      const worse = worseAwakenings(a);
      if (worse.length) return { action: 'finish', reason: `${challenger.label} scored better but ${worse.join(' and ')} got worse; keeping ${run.exp.arms[0]!.label}` };
      return { action: 'adopt', arm: challenger.key, curveId: challenger.curve_id ?? challenger.key, reason: `${challenger.label} is clearly better: ${a.verdict}` };
    }
    if (a.status === 'clear_winner') return { action: 'finish', reason: `${run.exp.arms[0]!.label} stays: ${a.verdict}` };
    if (a.done) return { action: 'finish', reason: `no clear winner after ${a.counted} nights; keeping ${run.exp.arms[0]!.label}` };
    return { action: 'none', reason: `testing ${challenger.label}: ${a.counted} nights counted` };
  }
  const cand = nextCandidate(i.defaultCurveId, i.history, i.candidates);
  if (!cand) return { action: 'none', reason: `every candidate was tested against ${curveName(i.defaultCurveId)}` };
  return { action: 'start', curveId: cand, reason: `next test: ${curveName(cand)} vs ${curveName(i.defaultCurveId)}` };
}
