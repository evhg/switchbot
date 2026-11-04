// Lab › Experiments (2026-11-04, migration 0025): data types. JSON shapes match the database (snake_case where a value
// is stored as jsonb as-is: ExperimentArm in experiments.arms, NightOutcomes in experiment_nights.outcomes).
import type { TagKey } from '../types.ts';

/** 'auto': Sleep Lab switches the arm itself (aircon curve per night). 'manual': the household does it (door, earplugs …). */
export type ExperimentKind = 'auto' | 'manual';
/** Stored status. The live verdict ('running' | 'leaning' | 'clear_winner' | 'no_difference') is ExperimentAnalysis.status. */
export type ExperimentStatus = 'running' | 'finished' | 'stopped';

export interface ExperimentArm {
  /** Short stable key, e.g. 'closed' / 'open' / 'steady-18-5-quiet-v1'. The FIRST arm is the control (today's habit). */
  key: string;
  /** Plain label for the app: "Door closed". */
  label: string;
  /** Auto arms: the curve the night runs (nights.curve_id). */
  curve_id?: string;
  /** Manual arms: what to do tonight, used in the 20:30 push: "Door OPEN a crack". */
  instruction?: string;
  /** Optional night tag set automatically on nights with this arm (only existing TagKeys, e.g. 'door_ajar'). */
  tag?: TagKey;
}

export interface Experiment {
  id?: number;
  slug: string;
  title: string;
  kind: ExperimentKind;
  arms: ExperimentArm[];
  /** OutcomeKey of the decision metric (see OUTCOMES). */
  primaryOutcome: string;
  status: ExperimentStatus;
  /** First night (wake date) the experiment may assign. */
  startedOn: string;
  endedOn?: string | null;
  winnerArm?: string | null;
  /** Randomisation seed: the same seed and the same counted nights always give the same assignments. */
  seed: number;
  /** Started by Autopilot (auto experiments only). */
  autopilot?: boolean;
  notes?: string | null;
  /** Counted nights each arm needs before a verdict (default 4; Autopilot uses 6). */
  minPerArm?: number;
  /** Counted nights after which the experiment finishes on its own (default 21). */
  maxNights?: number;
}

export type ExperimentNightSource = 'random' | 'pinned';

export interface ExperimentNight {
  /** Wake date (nights.date). */
  nightDate: string;
  armKey: string;
  source: ExperimentNightSource;
  /** false = "didn't follow" (one tap in the app): the night does not count. */
  followed: boolean;
  /** null until the morning computation (from 10:00 ICT). */
  outcomes: NightOutcomes | null;
}

/** One person's night from the watch's sleep stages. null = no stage data. */
export interface PersonOutcomes {
  /** Lights-out → first non-awake stage, minutes (0 when asleep before lights-out). */
  onsetMin: number;
  deepMin: number;
  remMin: number;
  lightMin: number;
  /** Awake minutes between the first and the last sleep stage. */
  awakeMin: number;
  /** Awake runs ≥ 2 min between the first and the last sleep stage. */
  awakenings: number;
}

export interface NightOutcomes {
  /** By person id ('a' = Cath, 'b' = Erik); a person without stage data is absent. */
  people: Record<string, PersonOutcomes>;
  /** Room, lights-out → wake (plausible CO₂ only). null = too little room data. */
  co2Mean: number | null;
  co2Over1000Min: number | null;
  tempMean: number | null;
  /** Minutes with snore_s ≥ 10 (sound_minutes), lights-out → wake. null = the listener heard nothing that night. */
  snoreMin: number | null;
  /** What was missing: 'room', 'sound', 'sleep:a', 'sleep:b'. */
  missing: string[];
}
