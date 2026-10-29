# @sleep-lab/core: module contract

Pure TypeScript with no runtime dependencies. It runs unchanged in Node 22, Deno (Supabase Edge Functions) and the browser.

**Rules**
- Imports must use explicit `.ts` extensions. Deno needs them.
- Use only Web-standard APIs: `fetch`, `crypto.subtle`, `crypto.randomUUID`, `TextEncoder`. No Node built-ins.
- Data types live in `src/types.ts`. Curve helpers (`DEFAULT_CURVE`, `CURVE_V1`, `phaseAt`, `targetAt`) live in `src/curve.ts`. Both are fixed: don't change them without updating every consumer.

**Default curve: "one beep per night" (`one-beep-v1`, since 2026-10-29)**
```ts
export const DEFAULT_CURVE: TemperatureCurve   // id 'one-beep-v1', every phase fan 'auto':
//   precool −30 min 19 °C · onset 0 19 · deep +30 19 · middle +270 (4 h 30) 21 = THE warming step · late +360 21 · wake +510 21
//   Quiet mode plan (bias −1): ON 18 at lights-out − 30 · nothing at lights-out · set 20 at +4 h 30 (the ONE command while
//   asleep) · OFF at wake + 30 min. Reasoning in curve.ts (RESEARCH.md §6).
export const CURVE_V1: TemperatureCurve        // the previous default ('default-v1': precool −90, ramp, 3 beeps while asleep)
// CurvePhase.fan?: FanSpeed (optional): the phase's fan for setAll remotes; omitted = 'high' for precool, 'low' after.
// fanFor(remote, phaseName, curve?) applies it (a ladder remote is always 'auto').
```
The backend inserts `one-beep-v1` as the default `curves` row (migration 0009); nights stored with `default-v1` keep it.
- Every module is re-exported from `src/index.ts`.
- Tests go in `packages/core/test/*.test.ts` and run with vitest.

**Daily vitals (optional fields, added after Phase 0)**
- `PersonNight.steps`: total steps on the ICT calendar day *before* the wake date (the day leading into the night).
- `PersonNight.restingHr`: Google `daily-resting-heart-rate` for the wake date, bpm.
- `PersonNight.hrvDailyMs` / `deepRmssdMs`: Google `daily-heart-rate-variability` average and deep-sleep RMSSD for the wake date, ms.
- `PersonNightMetrics.steps` / `restingHr` / `deepRmssd` mirror them. All are optional; a missing day stays `undefined`.
- Supabase stores them in `health_vitals_daily` (one row per person and *calendar* date; see migration 0003).

## sim/: deterministic simulator (owner: sim agent)
```ts
export interface Rng { next(): number; normal(mean?: number, sd?: number): number; int(min: number, max: number): number; chance(p: number): boolean; pick<T>(xs: readonly T[]): T }
export function createRng(seed: number): Rng

export const DEFAULT_PEOPLE: Person[]            // [{id:'a',name:'You',colorKey:'personA'},{id:'b',name:'Erik',colorKey:'personB'}]; the PWA lets you rename both
export interface SimOptions {
  seed?: number;               // default 42
  nights?: number;             // default 60
  endDate?: string;            // wake date (YYYY-MM-DD, ICT) of the LAST night; default = today in ICT
  people?: Person[];
  curve?: TemperatureCurve;    // default DEFAULT_CURVE
  remote?: RemoteProfile;      // default DEFAULT_REMOTE (setAll, quiet mode ON); withQuiet(DEFAULT_REMOTE, false) = closed loop
  volumeM3?: number;           // default 120
}
export function simulateNights(opts?: SimOptions): Night[]               // oldest → newest, 1-min room data 18:00→12:00 ICT, truth populated
// PersonNight also carries daily values: steps (day before the wake date; personal mean, weekday/weekend pattern, +3–6k on
// late_exercise days, about +1 min deep sleep per +1k steps over the mean, capped) and restingHr (≈ nadir + 3.5–4 bpm).
export function simulateLiveReading(now: Ms, opts?: SimOptions): RoomReading   // plausible "current" reading for any instant
```

## control/: aircon controller (owner: sim agent)
```ts
export interface QuietConfig {                     // every field optional; omitted = DEFAULT_QUIET
  enabled?: boolean;                               // default true (quiet mode ON)
  settleMin?: number;                              // default 15: lights-out + 15 min still behaves as before lights-out
  emergencyThresholdC?: number;                    // default 1.5 °C (bed-height room vs the target quiet mode holds)
  emergencyMinMinutes?: number;                    // default 20
  maxEmergencyPerNight?: number;                   // default 1
  maxExtraPerNight?: number;                       // default 1: emergencies + resends while asleep, one shared budget
  rampStrategy?: 'third' | 'midpoint' | 'end';     // default 'third' (see below)
}
export const DEFAULT_QUIET: Required<QuietConfig>
export function resolveQuiet(remote: RemoteProfile): Required<QuietConfig>   // a stored profile without `quiet` → quiet ON
export function withQuiet(remote: RemoteProfile, enabled: boolean): RemoteProfile
export interface RemoteProfile {
  kind: 'setAll' | 'customize';
  ladder?: { button: string; state: AcState }[];   // for 'customize': learned buttons, e.g. C18..C24
  minIntervalMin: number;                          // default 20; IR receivers beep, so keep commands rare
  maxCommandsPerNight: number;                     // default 12
  quietAfterLightsOutMin?: number;                 // optional: no commands in the first N min (closed-loop mode)
  quiet?: QuietConfig;                             // quiet mode while asleep; default ON
}
export const DEFAULT_REMOTE: RemoteProfile        // setAll, quiet: DEFAULT_QUIET
export const DEFAULT_LADDER_REMOTE: RemoteProfile
export function remoteCommand(now: Ms, state: AcState, remote: RemoteProfile, reason: string): AcCommand | null  // setAll or nearest ladder button
export interface ControllerInput {
  now: Ms; lightsOut: Ms; wake: Ms;
  curve: TemperatureCurve;
  remote: RemoteProfile;
  lastCommand?: AcCommand;            // our assumed current AC state
  commandsTonight: number;
  recent: RoomReading[];              // last ≥30 min of readings, ascending (quiet mode wants ~60 min)
  biasC?: number;                     // prior setpoint − bed target, default −1
  tonight?: AcCommand[];              // tonight's commands so far, ascending. Quiet mode needs it to count extras while asleep:
                                      // WITHOUT it quiet mode sends no emergency and no resend while asleep (planned steps only)
}
export function decideAcCommand(input: ControllerInput): AcCommand | null
// Closed loop (quiet off, and in quiet mode before lights-out + settleMin): setpoint = round(target + bias). Bias is a
// small integer offset (−2..+2) learned from the bed-height error (the ducted unit's return-air sensor differs from
// the bed); between calls it is carried by the last command, recovered exactly from its setpoint and target
// (recoverBias: set 20 for 20.5 °C is bias −1, never the −0.5 rounding residue). Respect minInterval and the nightly
// cap. Never send a duplicate state. Mark the prior command landed=false if the room didn't move toward the target
// within ~30 min of a change, and resend it once. Power on from precool
// until wake+30 min, then OFF.
// Quiet mode (default) from lights-out + settleMin until the OFF at wake + 30 min — the receiver beeps on every frame:
//  - only the planned steps from quietSteps(): each non-ramped phase start (deep, late, wake) and ONE step per ramped
//    phase; a step whose rounded setpoint (or ladder button) would not change under the bias in use is skipped; a step
//    not sent within 30 min of its time (minInterval, backoff) is dropped. A step inside the settle window (lights-out →
//    lights-out + settle, e.g. a phase at +10 blocked by minInterval after the onset command) is carried into quiet
//    mode with the 30 min measured from asleepFrom, unless the next step is due within 30 min (that one carries it).
//    Bias: the one the last command was sent with (an emergency's carries its correction), replaced by the one measured
//    at the step time (room steady under an unchanged setpoint ≥ 45 min) only when they differ by > 0.75 °C, by ≤ 1 °C
//    per step. A re-measured bias never adds a step (noChange is judged with the bias in use), and a step never moves
//    against the plan. So the number of planned steps while asleep always equals planAcSchedule's asleepCount.
//  - rampStrategy 'third': at 1/3 of the ramp, jump to the target 2/3 along (minimax error Δ/3 = 0.8 °C for the default
//    19 → 21.5 ramp; the next phase's step finishes it). 'midpoint': midpoint → midpoint target (Δ/2). 'end': no step.
//  - extras: at most maxExtraPerNight (default 1) in total while asleep, each an emergency or a resend:
//  - emergency: at most maxEmergencyPerNight, when every reading of the last emergencyMinMinutes is ≥ threshold off the
//    target quiet mode holds (the staircase, not the ramp), the room is not converging, the last command is ≥ 45 min
//    old and no planned step in the same direction is due within 30 min. setpoint ± round(deviation), max 2.
//  - resend: only of a planned "curve: …" command that is not a fan-only change.
//  → at most asleepCount + maxExtraPerNight commands (beeps) while asleep: 1 + 1 for the default curve (3 + 1 for CURVE_V1).
//  - always: minInterval, the nightly cap (last slot kept for OFF), setpoint within ceil(minC)..floor(maxC) and 16..30.
//  Reasons: "curve: <phase> start (quiet) …", "curve: <phase> ramp (one step) (quiet) …", "emergency: …", "resend: …".

export interface QuietStep { ts: Ms; targetC: number; phase: CurvePhaseName; kind: 'phase' | 'ramp' }
export function quietSteps(curve, lightsOut, wake, quiet: Required<QuietConfig>): QuietStep[]   // from lights-out (settle window included)
export function recoverBias(sp: number, targetC: number, limits: { lo: number; hi: number }, prior: number, maxAbs?: number): number
export interface PlannedAcCommand { ts: Ms; state: AcState; button?: string; targetC: number | null; phase: CurvePhaseName | 'off';
  kind: 'on' | 'phase' | 'ramp' | 'off'; reason: string; asleep: boolean /* lights-out + settle ≤ ts < wake: a beep while asleep */ }
export interface AcPlan { quiet: boolean; commands: PlannedAcCommand[]; asleepCount: number; total: number;
  maxExtraAsleep: number | null /* quiet: maxExtraPerNight (emergency or resend); null when quiet is off */; asleepFrom: Ms }
export function planAcSchedule(input: { curve; lightsOut: Ms; wake: Ms; remote: RemoteProfile; biasC?: number }): AcPlan
// Pure: the schedule the controller plans (constant bias: biasC rounded, default −1; no misses or emergencies; each
// command at least minInterval after the previous one; same step rules as above). The controller's planned steps while
// asleep match it in number; their setpoints may differ by 1 °C once the bias is measured (more after an emergency).
// Default (one-beep) curve, quiet ON: precool 18 at −30 · (onset, deep skipped: same setpoint and fan) · middle 20 at
// +270 · (late, wake skipped) · OFF at wake + 30 → 1 while asleep (3 + 1 extra for CURVE_V1: precool 20 · onset 19 ·
// deep 18 · middle ramp step 20 at +280 · late 21 · OFF). test/integration.test.ts checks plan vs. controller per command
// on simulated nights.
```

## metrics/: analysis (owner: metrics agent)
```ts
export function dewPointC(tempC: number, rh: number): number
export function absoluteHumidityGm3(tempC: number, rh: number): number
export function fitDecayAch(readings: RoomReading[], opts?: { outdoorCo2?: number; minMinutes?: number }):
  { ach: number; r2: number; start: Ms; end: Ms; baseline: number } | null
export function fitBuildup(readings: RoomReading[], opts?: { outdoorCo2?: number; volumeM3?: number; ach?: number }):
  { generationLps: number; ach: number; r2: number } | null
export function forecastCo2(readings: RoomReading[], untilTs: Ms, opts?: { outdoorCo2?: number; volumeM3?: number }):
  { ts: Ms; co2: number }[]
export function detectEvents(readings: RoomReading[], opts?: { lightsOut?: Ms; wake?: Ms }): RoomEvent[]
  // shower (RH spike), door_open (sharp CO2 drop), in_bed / both_in_bed (CO2 rise rate), room_empty
export function roomNightMetrics(night: Night, curve: TemperatureCurve): RoomNightMetrics
export function personNightMetrics(night: Night, personId: string, history?: Night[]): PersonNightMetrics
  // passes through steps / restingHr; deepRmssd = PersonNight.deepRmssdMs, else HRV windows centred in deep sleep;
  // rmssdMean falls back to PersonNight.hrvDailyMs when there are no HRV samples
export function baselineBand(values: number[], k?: number): { mean: number; sd: number; lo: number; hi: number }
export function buildRuleReport(night: Night, history: Night[], curve: TemperatureCurve): NightReport
export function downsample<T extends { ts: Ms }>(xs: T[], bucketMs: number, pick: 'mean' | 'last'): T[]
```

## switchbot/ and health/: API adapters (owner: adapters agent)
```ts
// switchbot/
export async function switchBotSignHeaders(token: string, secret: string, opts?: { t?: number; nonce?: string }): Promise<Record<string, string>>
export class SwitchBotClient { /* listDevices, getStatus, sendCommand, setAll, customize, setupWebhook, queryWebhook, deleteWebhook; quota tracking; 429/backoff */ }
export class SwitchBotError extends Error { status?: number; statusCode?: number }
export function acStateToSetAllParam(state: AcState): string   // "19,2,1,on"
export function toSwitchBotCommand(cmd: AcCommand): { commandType: 'command' | 'customize'; command: string; parameter: string }
export function parseMeterStatus(body: unknown, receivedAt: Ms): RoomReading | null
export function parseWebhookEvent(body: unknown, receivedAt: Ms): { deviceMac: string; deviceType: string; reading: RoomReading | null } | null
// health/ (Google Health API v4)
export class GoogleHealthClient { /* listDataPoints(type, filter, pageToken), paginate; identity; pairedDevices */ }
export function googleAuthUrl(...): string; export async function exchangeCode(...); export async function refreshAccessToken(...)
export function parseHeartRate(json: unknown): HrSample[]
export function parseHrv(json: unknown): HrvSample[]
export function parseSpo2(json: unknown): Spo2Sample[]
export function parseSleep(json: unknown, personId: string): SleepSession[]
export function parseCivilDate(v: unknown): string | null                       // Google Date {year,month,day} or "YYYY-MM-DD"
export function parseStepIntervals(json: unknown): { start: Ms; end: Ms; count: number }[]
export function dailyStepTotals(json: unknown, utcOffsetMin?: number): { date: string; steps: number }[]   // default ICT (+420)
export function parseDailyRestingHr(json: unknown): { date: string; bpm: number; method?: string }[]
export function parseDailyHrv(json: unknown): { date: string; averageMs?: number; deepSleepRmssdMs?: number; nonRemHr?: number }[]
export async function verifyGoogleHealthSignature(...): Promise<boolean>   // best effort; see docs/research/health-data.md
```
