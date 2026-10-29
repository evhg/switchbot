// Shared data contract for the whole system: simulator, metrics, Supabase functions and the web app.
// Conventions:
// - Timestamps are epoch milliseconds (UTC). Display is in Asia/Bangkok (ICT, UTC+7).
// - Temperatures in °C, relative humidity in %, CO2 in ppm.
// - A "night" is keyed by the local calendar date of the wake-up morning (YYYY-MM-DD).

export type Ms = number;

/** Where a row came from. 'sim' = synthetic data from the simulator. */
export type DataSourceKind = 'webhook' | 'poll' | 'ble' | 'sim' | 'manual';

export interface RoomReading {
  ts: Ms;
  tempC: number;
  /** Relative humidity, integer % in real data. */
  rh: number;
  /** CO2 ppm, integer in real data. */
  co2: number;
  source: DataSourceKind;
}

export interface OutdoorReading {
  ts: Ms;
  tempC: number;
  rh: number;
}

// ---------- Air conditioner (IR, open loop) ----------

export type AcMode = 'auto' | 'cool' | 'dry' | 'fan' | 'heat';
export type FanSpeed = 'auto' | 'low' | 'medium' | 'high';

export interface AcState {
  power: boolean;
  /** Integer °C, 16..30 (SwitchBot setAll accepts integers only). */
  setpointC: number;
  mode: AcMode;
  fan: FanSpeed;
}

export interface AcCommand {
  ts: Ms;
  /** The full state we commanded (IR sends full state frames). */
  state: AcState;
  /** 'setAll' when the remote is DB-matched, 'customize' when a learned button ladder is used. */
  via: 'setAll' | 'customize';
  /** Learned button name when via = 'customize', e.g. 'C19'. */
  button?: string;
  /** Human-readable reason, e.g. 'curve: deep phase 19°C' or 'correction: +1 (room 0.8° above target)'. */
  reason: string;
  /** Whether the room temperature responded as expected (null = not evaluated yet). */
  landed?: boolean | null;
}

// ---------- Temperature curve (Eight-Sleep-style, applied to room air) ----------

export type CurvePhaseName = 'precool' | 'onset' | 'deep' | 'middle' | 'late' | 'wake';

export interface CurvePhase {
  name: CurvePhaseName;
  /** Minutes relative to lights-out (negative = before). Phase lasts until the next phase starts. */
  startMin: number;
  /** Target room air temperature at bed height, °C (may be fractional; the controller rounds for IR). */
  targetC: number;
  /** If true, linearly ramp from this phase's target to the next phase's target. */
  ramp?: boolean;
  /**
   * Fan speed for this phase (setAll remotes). Omitted = 'high' for precool, 'low' after. A curve that wants no
   * command at lights-out gives every phase the same fan, so the precool → onset boundary is not a fan-only change.
   */
  fan?: FanSpeed;
  /**
   * What `startMin` is relative to. 'lightsOut' (default, every curve before one-beep-v2): minutes from lights-out.
   * 'sleepOnset': minutes from the night's expected sleep onset (Night.sleepOnset, default lights-out + 60 min), so the
   * deep window and the warming step follow when people actually fall asleep, not when they get into bed. Resolve a
   * curve for a night with resolveCurve() (curve.ts); phaseAt / targetAt do it for you.
   */
  anchor?: PhaseAnchor;
}

export type PhaseAnchor = 'lightsOut' | 'sleepOnset';

export interface TemperatureCurve {
  id: string;
  name: string;
  phases: CurvePhase[];
  /** Hard safety limits. */
  minC: number;
  maxC: number;
}

// ---------- Room events (derived) ----------

export type RoomEventKind =
  | 'shower'
  | 'door_open'
  | 'in_bed'
  | 'both_in_bed'
  | 'out_of_bed'
  | 'room_empty'
  | 'ac_missed'
  | 'calibration';

export interface RoomEvent {
  kind: RoomEventKind;
  start: Ms;
  end?: Ms;
  /** 0..1 */
  confidence: number;
  detail?: Record<string, number | string>;
}

// ---------- Body (Google Health API v4 shaped, simplified) ----------

export type SleepStage = 'awake' | 'light' | 'deep' | 'rem';

export interface StageSegment {
  start: Ms;
  end: Ms;
  stage: SleepStage;
}

export interface HrSample {
  ts: Ms;
  bpm: number;
}

export interface HrvSample {
  /** Start of the measurement window (≈5 min windows during sleep). */
  ts: Ms;
  rmssdMs: number;
}

export interface Spo2Sample {
  ts: Ms;
  pct: number;
}

export interface SleepSession {
  personId: string;
  start: Ms;
  end: Ms;
  stages: StageSegment[];
  /** Google reprocesses nights; keep the version we saw. */
  updateTime?: Ms;
}

export interface Person {
  id: string;
  name: string;
  /** Display colour token key, e.g. 'personA'. */
  colorKey: string;
}

export interface PersonNight {
  personId: string;
  sleep: SleepSession;
  hr: HrSample[];
  hrv: HrvSample[];
  spo2: Spo2Sample[];
  /** Breaths/min, whole-sleep average (Google: respiratory-rate-sleep-summary). */
  respRate?: number;
  /** Nightly temperature deviation vs 30-day baseline, °C (Google: daily-sleep-temperature-derivations). */
  tempDeviationC?: number;
  // Daily values. All optional: a missing day (watch off the wrist, sync gap) leaves them undefined.
  /** Total steps on the local (ICT) calendar day BEFORE the wake date, i.e. the day leading into this night (Google: steps). */
  steps?: number;
  /** Resting heart rate for the wake date, bpm (Google: daily-resting-heart-rate). Usually a few bpm above the sleeping nadir. */
  restingHr?: number;
  /** Google's nightly average RMSSD, ms (daily-heart-rate-variability.averageHeartRateVariabilityMilliseconds). Used when there are no HRV samples. */
  hrvDailyMs?: number;
  /** Deep-sleep RMSSD, ms (daily-heart-rate-variability.deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds). */
  deepRmssdMs?: number;
}

// ---------- Tags (one-tap evening context) ----------

export type TagKey =
  | 'alcohol'
  | 'late_caffeine'
  | 'late_meal'
  | 'late_exercise'
  | 'heavy_duvet'
  | 'door_ajar'
  | 'sick'
  | 'travel';

// ---------- A full night ----------

export interface Night {
  /** Wake-up local date, YYYY-MM-DD (ICT). */
  date: string;
  lightsOut: Ms;
  wake: Ms;
  /**
   * Expected sleep onset (when the household is asleep; lights-out is getting into bed). Curves whose phases are
   * anchored to 'sleepOnset' count from it. Undefined = lights-out + DEFAULT_SLEEP_ONSET_MIN (60 min).
   */
  sleepOnset?: Ms;
  /** Room data for a window around the night (typically 18:00 → 12:00 next day), 1-min resolution when available. */
  room: RoomReading[];
  outdoor: OutdoorReading[];
  ac: AcCommand[];
  /** Curve that was active that night. */
  curveId: string;
  events: RoomEvent[];
  people: PersonNight[];
  tags: TagKey[];
  /** For simulated data only: the ground truth the detectors should recover. */
  truth?: SimTruth;
}

export interface SimTruth {
  /** Effective air changes per hour used by the simulator that night. */
  ach: number;
  events: RoomEvent[];
  /** Per-person CO2 generation, L/s, while asleep. */
  co2GenLps: Record<string, number>;
}

// ---------- Metrics & scores ----------

export interface RoomNightMetrics {
  date: string;
  co2Mean: number;
  co2P95: number;
  co2Max: number;
  minutesCo2Over1000: number;
  minutesCo2Over1500: number;
  tempMean: number;
  /** Mean temperature in the first 4 h after lights-out. */
  tempEarlyMean: number;
  minutesTempInTarget: number;
  minutesTempOver24: number;
  rhMean: number;
  minutesRhOver60: number;
  minutesRhInBand: number;
  /** Fitted next-morning decay ACH, null if no clean decay window. */
  achMorning: number | null;
  /** 0..100 */
  sleepAirScore: number;
  acCommands: number;
}

export interface PersonNightMetrics {
  date: string;
  personId: string;
  totalSleepMin: number;
  deepMin: number;
  remMin: number;
  lightMin: number;
  awakeMin: number;
  efficiencyPct: number;
  latencyMin: number;
  awakenings: number;
  hrNadir: number;
  /** Minutes after sleep start at which the HR nadir occurred. */
  hrNadirAtMin: number;
  hrMeanAsleep: number;
  rmssdMean: number;
  spo2Mean: number;
  /** Dips ≥3 % below the rolling baseline, per hour of sleep. */
  spo2DipsPerHour: number;
  respRate?: number;
  tempDeviationC?: number;
  /** Steps on the day before the night (PersonNight.steps). */
  steps?: number;
  /** Daily resting HR, bpm (PersonNight.restingHr). */
  restingHr?: number;
  /** Deep-sleep RMSSD, ms: PersonNight.deepRmssdMs, else the mean of HRV windows centred in deep sleep. */
  deepRmssd?: number;
  /** 0..100 */
  sleepScore: number;
  /** 0..100 */
  recoveryScore: number;
}

export interface ScoreDriver {
  label: string;
  /** Signed contribution in score points. */
  points: number;
}

export interface NightReport {
  date: string;
  room: RoomNightMetrics;
  people: PersonNightMetrics[];
  drivers: ScoreDriver[];
  headline: string;
  insights: string[];
  generatedBy: 'rules' | 'claude';
}
