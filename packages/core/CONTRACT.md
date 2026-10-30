# @sleep-lab/core: module contract

Pure TypeScript with no runtime dependencies. It runs unchanged in Node 22, Deno (Supabase Edge Functions) and the browser.

**Rules**
- Imports must use explicit `.ts` extensions. Deno needs them.
- Use only Web-standard APIs: `fetch`, `crypto.subtle`, `crypto.randomUUID`, `TextEncoder`. No Node built-ins.
- Data types live in `src/types.ts`. Curve helpers (`DEFAULT_CURVE`, `ONE_BEEP_V1`, `CURVE_V1`, `phaseAt`, `targetAt`, `resolveCurve`) live in `src/curve.ts`. Both are fixed: don't change them without updating every consumer.

**Default curve: "steady 18.5" (`steady-18-5-v1`, since 2026-10-30 evening)**
```ts
export const DEFAULT_CURVE: TemperatureCurve   // id 'steady-18-5-v1', minC 16, maxC 24, every phase fan 'auto', from lights-out:
//   precool −30 18.5 · onset 0 18.5 · deep +30 18.5 · middle +270 18.5 · late +360 18.5 · wake +630 18.5
//   No warming: the room must not warm while either sleeper may still be in deep sleep (stages are not live overnight).
//   Quiet mode plan, 22:00 lights-out, wake 08:30: ON at 21:30 (set 18 with bias −1, set 17 with the live bias −2) ·
//   NOTHING at 22:00, at sleep onset or while asleep (asleepCount 0) · OFF at 09:00 (wake + 30).
export const ONE_BEEP_V2: TemperatureCurve     // 'one-beep-v2' (default 2026-10-30 morning): precool −30 19 · onset 0 19 (from
//   LIGHTS-OUT) · deep +30 19 · middle +270 21 = THE warming step · late +360 21 · wake +570 21 (from SLEEP ONSET)
export const ONE_BEEP_V1: TemperatureCurve     // 'one-beep-v1' (default 2026-10-29): same, every phase from lights-out (wake +510)
export const CURVE_V1: TemperatureCurve        // 'default-v1': precool −90, ramp, 3 beeps while asleep
export const BUILTIN_CURVES                    // [DEFAULT_CURVE, ONE_BEEP_V2, ONE_BEEP_V1, CURVE_V1]
// CurvePhase.fan?: FanSpeed (optional): the phase's fan for setAll remotes; omitted = 'high' for precool, 'low' after.
// fanFor(remote, phaseName, curve?) applies it (a ladder remote is always 'auto').
// CurvePhase.anchor?: 'lightsOut' | 'sleepOnset' (optional, default 'lightsOut'): what startMin counts from.
// Night.sleepOnset?: Ms (expected sleep onset; undefined = lights-out + DEFAULT_SLEEP_ONSET_MIN = 60 min).
export const DEFAULT_SLEEP_ONSET_MIN = 60, MAX_SLEEP_ONSET_MIN = 180
export function sleepOnsetOffsetMin(lightsOut, sleepOnset?): number      // clamped to 0 … 180, default 60
export function expectedSleepOnset(lightsOut, sleepOnset?): Ms
export function usesSleepOnset(curve): boolean
export function resolveCurve(curve, lightsOut, sleepOnset?): TemperatureCurve   // every phase from lights-out; a curve without
//   onset-anchored phases is returned unchanged (older nights behave exactly as before)
export function anchorCurve(resolved, template, offsetMin): TemperatureCurve    // inverse, for editors
export function phaseAt(curve, lightsOut, ts, sleepOnset?) / targetAt(curve, lightsOut, ts, sleepOnset?)   // resolve first
```
The backend inserts `steady-18-5-v1` as the default `curves` row (migration 0012); nights stored with `one-beep-v2`,
`one-beep-v1` or `default-v1` keep them. `nights.sleep_onset` (0011) is the night's expected onset (null = lights-out + 60).
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
// Night.sleepOnset: the expected onset the controller planned with: lights-out + 30, 60 or 90 min by date (no rng draw).
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
  emergencyWarm?: boolean;                         // default false (2026-10-30): an emergency never WARMS the room while asleep
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
  sleepOnset?: Ms;                    // expected sleep onset for onset-anchored curves (default lights-out + 60); the
                                      // controller resolves the curve with it first. Give planAcSchedule the same value.
}
export function decideAcCommand(input: ControllerInput): AcCommand | null
// Closed loop (quiet off, and in quiet mode before lights-out + settleMin): setpoint = round(target + bias). Bias is a
// small integer offset (−2..+2) learned from the bed-height error (the ducted unit's return-air sensor differs from
// the bed); between calls it is carried by the last command, recovered exactly from its setpoint and target
// (recoverBias: set 20 for 20.5 °C is bias −1, never the −0.5 rounding residue). Respect minInterval and the nightly
// cap (minInterval allows 30 s of cron jitter: INTERVAL_SLACK_MS). Never send a duplicate state. Mark the prior command
// landed=false if the room didn't move toward the target within LANDING_MIN (30) min of a change, and resend it once.
// evaluateLanding (cooling): the pull-down must start ≤ 20 min after the command (a later drop, e.g. the handheld
// remote, is not credited) and the mean of the last 5 readings must be clamp(0.15 × gap, 0.3, 0.8) °C below the start.
// Power on from precool until wake+30 min, then OFF. A command that stalls (room > target + 2.5 °C and not cooling) is
// resent at most MAX_STALLED_RESENDS (2) times a night counting every resend, only before the expected sleep onset
// (also in quiet mode, outside its asleep extra budget; after lights-out never warmer than the state sent); without
// `tonight` never a resend of a resend. Reason "resend: room …". Quiet mode's emergency only considers readings after
// lights-out + settleMin (its whole window lies in the asleep period, so the evening pull-down never triggers it).
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
//    Only a too-WARM room is corrected (setpoint down) unless quiet.emergencyWarm: a too-cold room is never warmed asleep.
//  - resend: only of a planned "curve: …" command that is not a fan-only change.
//  → at most asleepCount + maxExtraPerNight commands (beeps) while asleep: 0 + 1 for the default steady curve (1 + 1 for
//    one-beep-v1/v2, 3 + 1 for CURVE_V1).
//  - always: minInterval, the nightly cap (last slot kept for OFF), setpoint within ceil(minC)..floor(maxC) and 16..30.
//  Reasons: "curve: <phase> start (quiet) …", "curve: <phase> ramp (one step) (quiet) …", "emergency: …", "resend: …".

export interface QuietStep { ts: Ms; targetC: number; phase: CurvePhaseName; kind: 'phase' | 'ramp' }
export function quietSteps(curve, lightsOut, wake, quiet: Required<QuietConfig>): QuietStep[]   // from lights-out (settle window included)
export function recoverBias(sp: number, targetC: number, limits: { lo: number; hi: number }, prior: number, maxAbs?: number): number
export interface PlannedAcCommand { ts: Ms; state: AcState; button?: string; targetC: number | null; phase: CurvePhaseName | 'off';
  kind: 'on' | 'phase' | 'ramp' | 'off'; reason: string; asleep: boolean /* lights-out + settle ≤ ts < wake: a beep while asleep */ }
export interface AcPlan { quiet: boolean; commands: PlannedAcCommand[]; asleepCount: number; total: number;
  maxExtraAsleep: number | null /* quiet: maxExtraPerNight (emergency or resend); null when quiet is off */; asleepFrom: Ms }
export function planAcSchedule(input: { curve; lightsOut: Ms; wake: Ms; remote: RemoteProfile; biasC?: number; sleepOnset?: Ms }): AcPlan
// AcPlan.sleepOnset: the expected onset used (lights-out + 60 by default).
// Pure: the schedule the controller plans (constant bias: biasC rounded, default −1; no misses or emergencies; each
// command at least minInterval after the previous one; same step rules as above). The controller's planned steps while
// asleep match it in number; their setpoints may differ by 1 °C once the bias is measured (more after an emergency).
// Default (steady-18-5-v1) curve, quiet ON: precool at −30 (set 18 with bias −1, 17 with −2) · every later phase skipped
// (same setpoint and fan) · OFF at wake + 30 → 0 while asleep, whatever the sleep onset. one-beep-v2: precool 18 · middle 20
// at sleep onset + 270 · OFF → 1 while asleep (one-beep-v1: middle at lights-out + 270; 3 + 1 extra for CURVE_V1:
// precool 20 · onset 19 · deep 18 · middle ramp step 20 at +280 · late 21 · OFF).
// test/integration.test.ts checks plan vs. controller per command on simulated nights (expected onset lights-out + 30 /
// 60 / 90 min): the steady curve plans nothing while asleep, the controller sends no planned step while asleep, at most
// one safety net (a resend, or an emergency that cools), and every emergency lowers the setpoint.
// test/control.test.ts: ideal nights (bed = setpoint + 1 / 2 / 1.5) send exactly the plan; one-beep-v2 keeps its own block.

export function acUnresponsive(input: ControllerInput): { roomC; targetC; since: Ms; commands: number } | null
// ≥ 2 power-on commands in a row without landed=true, the last ≥ 20 min old, room > target + 2.5 °C and not cooling.
// ac-curve sends one push per night, only before the expected sleep onset ("Aircon isn't cooling"), and stores an ac_missed event (detail.notice = 'unresponsive').
// Incident 2026-10-31 (set 17 ignored, room flat at 27.3): 21:30 ON · 21:50 resend · 22:10 resend + push · then nothing
// until the one cooling emergency (test/control.test.ts "incident 2026-10-31").
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
// Room metrics and the report read the curve's target with night.sleepOnset (onset-anchored curves).

// Typical sleep onset from the watches (metrics/onset.ts), for a new night's expected onset:
export function typicalSleepOnset(byPerson: Record<string, SleepSession[]> | SleepSession[], opts?: SleepOnsetOptions):
  { minuteOfDay: number; hhmm: string; personId: string; perPerson: PersonOnset[] } | null
//   per person: median onset (first non-awake stage) of the last 14 main sleeps (≥ 180 min, starting 18:00–04:00 ICT,
//   one per wake date; naps ignored), ≥ 3 nights needed; median on a noon-to-noon clock (wraps midnight).
//   household: the LATER of the medians (the room stays cool until both are asleep), rounded to 5 min. null = no data.
export function personSleepOnset(sessions, opts?): PersonOnset | null
export function sessionOnset(s: SleepSession): Ms
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
// CO2 < CO2_PLAUSIBLE_MIN (300 ppm, e.g. the 0 ppm warm-up artifact) gives no reading unless opts.co2Fallback (the
// previous valid CO2) is passed; then temp/RH are kept with that CO2. plausibleCo2(ppm) is the shared check.
export function parseMeterStatus(body: unknown, receivedAt: Ms, opts?: { co2Fallback?: number | null }): RoomReading | null
export function parseWebhookEvent(body: unknown, receivedAt: Ms, opts?: { co2Fallback?: number | null }): { deviceMac: string; deviceType: string; reading: RoomReading | null } | null
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

## metrics/quality.ts (2026-10-30)

```ts
export function cleanRoomReadings(readings: readonly RoomReading[], opts: CleanOptions): { readings: RoomReading[]; quality: RoomDataQuality }
// opts: { from, to, lightsOut, wake, frozenMin = 30, co2ChangePpm = 25, gapMin = 5, lowCoverage = 0.8 }
// Drops runs of identical temp+RH longer than frozenMin when CO2 moved >= co2ChangePpm ('temp_rh') or CO2 is identical
// too ('all'); keeps identical T/RH with only CO2 noise. Gaps = no row for > gapMin. CO2 < 300 rows are kept and counted.
// RoomDataQuality: { from, to, rawCount, keptCount, invalidCo2Count, frozen: FrozenStretch[], gaps: DataGap[],
//   frozenMinutes, frozenNightMinutes, gapMinutes, gapNightMinutes, coverage (0..1, lights-out → wake), coveragePct,
//   flags: ('frozen_temp_rh'|'frozen_all'|'gap_evening'|'gap_overnight'|'gap_morning'|'low_coverage'|'no_room_data'|'invalid_co2')[] }
```

## Manual nights and overnight ventilation (2026-10-30)

- `Night.manual?: boolean`: true when the controller sent no live command. `roomNightBreakdown` and `buildRuleReport`
  then score against `scoringCurve(night, plan)` = `manualComfortCurve()` (flat 18.5 °C). The backend and the app set
  it the same way, so they get the same score.
- `RoomNightMetrics.achPlateau / achPlateauKind / achPlateauPpm` come from `plateauAch(readings, wake)`.
  `detectEvents(readings, {lightsOut, wake, ach?})` uses this value in its occupancy mass balance when there is no
  measured decay.
