// Ready-made experiments for Lab › Experiments, and Autopilot's candidate list.
import { DEFAULT_CURVE, EXPERIMENT_CURVES, STEADY_19_5_QUIET_V1 } from '../curve.ts';
import type { ExperimentArm, ExperimentKind } from './types.ts';

export interface ExperimentTemplate {
  slug: string;
  title: string;
  kind: ExperimentKind;
  /** First arm = control. */
  arms: ExperimentArm[];
  primaryOutcome: string;
  /** One plain sentence for the app. */
  description: string;
}

/** The five templates ("Start one"). The first arm of each is today's habit (the control). */
export const EXPERIMENT_TEMPLATES: readonly ExperimentTemplate[] = [
  {
    slug: 'door-open-vs-closed',
    title: 'Door: open a crack vs closed',
    kind: 'manual',
    arms: [
      { key: 'closed', label: 'Door closed', instruction: 'Door CLOSED' },
      { key: 'open', label: 'Door open a crack', instruction: 'Door OPEN a crack', tag: 'door_ajar' },
    ],
    primaryOutcome: 'sleep_score',
    description: 'Does fresher air (lower CO₂) help you sleep, or does noise and light from outside cost more?',
  },
  {
    slug: 'earplugs',
    title: 'Earplugs vs none',
    kind: 'manual',
    arms: [
      { key: 'none', label: 'No earplugs', instruction: 'No earplugs' },
      { key: 'earplugs', label: 'Earplugs', instruction: 'Earplugs IN' },
    ],
    primaryOutcome: 'sleep_score',
    description: 'Do earplugs cut the awakenings from snoring and noise?',
  },
  {
    slug: 'aircon-late-19-5',
    title: 'Aircon: 18.5 vs 19.5 °C',
    kind: 'auto',
    arms: [
      { key: DEFAULT_CURVE.id, label: 'Steady 18.5 °C', curve_id: DEFAULT_CURVE.id },
      { key: STEADY_19_5_QUIET_V1.id, label: 'Steady 19.5 °C', curve_id: STEADY_19_5_QUIET_V1.id },
    ],
    primaryOutcome: 'sleep_score',
    description: 'Jarvis picks the aircon plan each night. Is a one-degree warmer night better? Both send their last command at lights-out: no beep while you sleep.',
  },
  {
    slug: 'no-screens',
    title: 'No screens in bed',
    kind: 'manual',
    arms: [
      { key: 'screens', label: 'Screens as usual', instruction: 'Screens as usual' },
      { key: 'no-screens', label: 'No screens in bed', instruction: 'NO screens in bed (phones out of the bedroom)' },
    ],
    primaryOutcome: 'sleep_score',
    description: 'Do you fall asleep faster without phones and laptops in bed?',
  },
  {
    slug: 'no-alcohol',
    title: 'No alcohol',
    kind: 'manual',
    arms: [
      { key: 'usual', label: 'As usual', instruction: 'Drinks as usual' },
      { key: 'none', label: 'No alcohol', instruction: 'NO alcohol tonight' },
    ],
    primaryOutcome: 'sleep_score',
    description: 'How much does an evening drink cost in deep sleep and awakenings?',
  },
];

/**
 * Autopilot's candidates, tested one at a time against the current default curve (all pass the controller rules).
 * The original default comes last, so after Autopilot adopted another curve it re-tests the old one against it.
 */
export const AUTOPILOT_CANDIDATES: readonly string[] = [...EXPERIMENT_CURVES.map((c) => c.id), DEFAULT_CURVE.id];
/** Autopilot needs more nights than a hand-started experiment before it changes the thermostat. */
export const AUTOPILOT_MIN_PER_ARM = 6;
