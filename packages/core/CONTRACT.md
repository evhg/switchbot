# @sleep-lab/core: module contract

Pure TypeScript with no runtime dependencies. It runs unchanged in Node 22, Deno (Supabase Edge Functions) and the browser.

**Rules**
- Imports must use explicit `.ts` extensions. Deno needs them.
- Use only Web-standard APIs: `fetch`, `crypto.subtle`, `crypto.randomUUID`, `TextEncoder`. No Node built-ins.
- Data types live in `src/types.ts`. Curve helpers (`DEFAULT_CURVE`, `phaseAt`, `targetAt`) live in `src/curve.ts`. Both are fixed: don't change them without updating every consumer.
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
  remote?: RemoteProfile;      // default setAll profile
  volumeM3?: number;           // default 120
}
export function simulateNights(opts?: SimOptions): Night[]               // oldest → newest, 1-min room data 18:00→12:00 ICT, truth populated
// PersonNight also carries daily values: steps (day before the wake date; personal mean, weekday/weekend pattern, +3–6k on
// late_exercise days, about +1 min deep sleep per +1k steps over the mean, capped) and restingHr (≈ nadir + 3.5–4 bpm).
export function simulateLiveReading(now: Ms, opts?: SimOptions): RoomReading   // plausible "current" reading for any instant
```

## control/: aircon controller (owner: sim agent)
```ts
export interface RemoteProfile {
  kind: 'setAll' | 'customize';
  ladder?: { button: string; state: AcState }[];   // for 'customize': learned buttons, e.g. C18..C24
  minIntervalMin: number;                          // default 20; IR receivers beep, so keep commands rare
  maxCommandsPerNight: number;                     // default 12
  quietAfterLightsOutMin?: number;                 // optional: no commands in the first N min
}
export const DEFAULT_REMOTE: RemoteProfile
export interface ControllerInput {
  now: Ms; lightsOut: Ms; wake: Ms;
  curve: TemperatureCurve;
  remote: RemoteProfile;
  lastCommand?: AcCommand;            // our assumed current AC state
  commandsTonight: number;
  recent: RoomReading[];              // last ≥30 min of readings, ascending
}
export function decideAcCommand(input: ControllerInput): AcCommand | null
// Strategy: setpoint = round(target + bias). Bias is a small integer offset (−2..+2) learned from the
// bed-height error (the ducted unit's return-air sensor differs from the bed). Respect minInterval and
// the nightly cap. Never send a duplicate state. Mark the prior command landed=false if the room
// didn't move toward the target within ~30 min of a change. Power on from precool until wake+30 min.
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
