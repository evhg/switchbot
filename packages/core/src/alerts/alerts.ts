// Phone alerts (alerts Edge Function, migration 0026): the pure decisions. Times are epoch ms; every user-facing time
// is ICT (UTC+7, no DST).
//
//   Fitbit battery   public.battery_log (one row per band sync that reported a level) → the current discharge cycle
//                    (readings since the last charge) → drain %/h by least squares once the cycle spans ≥ 3 h →
//                    hours left. "Charge your Fitbit before bed — 18 %, about 14 h left" when < 24 h are left or the
//                    level is ≤ 15 % (no rate yet: ≤ 20 %), once per discharge cycle, only 08:00–21:30 ICT (a crossing
//                    at night is sent at 08:00).
//   Stale sync       band last reached Google > 6 h ago while the server's own sync runs fine → one push per staleness
//                    episode (episode = that "last seen" time), only 08:00–22:00 ICT.
//   Night listener   the Mac should be listening (night-sound's decision) but no sound_minutes for 10 min → one push
//                    per night.
import type { Ms } from '../types.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const ICT = 7 * HOUR;

/** A rise of at least this many points between two readings is a charge (smaller rises are reporting jitter). */
export const CHARGE_RISE = 3;
/** The drain rate needs a cycle spanning at least this long. */
export const DRAIN_MIN_SPAN_MS = 3 * HOUR;
/** Alert when fewer hours than this are left … */
export const BATTERY_HOURS_LEFT = 24;
/** … or the level is at or below this … */
export const BATTERY_LOW = 15;
/** … or, while the drain rate is still unknown, at or below this. */
export const BATTERY_LOW_NO_RATE = 20;
/** Stale sync: the band hasn't reached Google for longer than this. */
export const STALE_SYNC_MS = 6 * HOUR;
/** The server's own sync must have run this recently for "stale" to mean the band (not the server). */
export const SERVER_SYNC_FRESH_MS = 2 * HOUR;
/** Night listener: no minute summary for this long inside the listen window. */
export const LISTENER_SILENT_MS = 10 * MIN;
/** Sending hours (ICT, [from, until)). */
export const BATTERY_HOURS = { from: '08:00', until: '21:30' } as const;
export const STALE_HOURS = { from: '08:00', until: '22:00' } as const;

export interface BatteryReading {
  ts: Ms;
  /** 0..100 */
  level: number;
}

export interface DrainEstimate {
  /** Last reported level and when. */
  level: number;
  at: Ms;
  /** Level projected to `now` with the drain rate (= level while the rate is unknown). */
  levelNow: number;
  /** %/h, ≥ 0; null until the cycle spans 3 h. */
  ratePerHour: number | null;
  /** Hours until empty from now; null while the rate is unknown or zero. */
  hoursLeft: number | null;
  /** First reading after the last charge: the discharge cycle's id. */
  cycleStart: Ms;
  readings: number;
}

export interface AlertSettings {
  battery: boolean;
  staleSync: boolean;
  listener: boolean;
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = { battery: true, staleSync: true, listener: true };

/** household_settings.alerts jsonb → settings; anything missing or not a boolean is on. */
export function parseAlertSettings(v: unknown): AlertSettings {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const b = (x: unknown) => (typeof x === 'boolean' ? x : true);
  return { battery: b(o.battery), staleSync: b(o.stale_sync), listener: b(o.listener) };
}

/** "14:20" ICT. */
export const ictHm = (ms: Ms) => new Date(ms + ICT).toISOString().slice(11, 16);
const ictDay = (ms: Ms) => new Date(ms + ICT).toISOString().slice(0, 10);
const minuteOfDay = (hhmm: string) => {
  const [h = '0', m = '0'] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
};

/** Is `now` inside [from, until) ICT (same day, from < until)? */
export function inIctHours(now: Ms, hours: { from: string; until: string }): boolean {
  const d = new Date(now + ICT);
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return m >= minuteOfDay(hours.from) && m < minuteOfDay(hours.until);
}

/** "14:20" today, "yesterday 14:20", else "Mon 14:20" (ICT, relative to `now`). */
export function whenText(ts: Ms, now: Ms): string {
  const d = ictDay(ts);
  if (d === ictDay(now)) return ictHm(ts);
  if (d === ictDay(now - 24 * HOUR)) return `yesterday ${ictHm(ts)}`;
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(ts + ICT).getUTCDay()]} ${ictHm(ts)}`;
}

/** "under an hour", "14 h", "5 days". */
export function hoursLeftText(h: number): string {
  if (h < 1) return 'under an hour';
  if (h < 48) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} days`;
}

/**
 * The current discharge cycle: valid readings (finite, 0..100) sorted by time, from the first reading after the last
 * charge (a rise of ≥ CHARGE_RISE points) to the newest. Duplicate timestamps keep the last one.
 */
export function batteryCycle(readings: readonly BatteryReading[]): BatteryReading[] {
  const byTs = new Map<number, BatteryReading>();
  for (const r of readings) {
    if (!Number.isFinite(r.ts) || !Number.isFinite(r.level) || r.level < 0 || r.level > 100) continue;
    byTs.set(r.ts, { ts: r.ts, level: r.level });
  }
  const sorted = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  let start = 0;
  for (let i = 1; i < sorted.length; i++) if (sorted[i]!.level - sorted[i - 1]!.level >= CHARGE_RISE) start = i;
  return sorted.slice(start);
}

/**
 * Drain estimate from the current cycle: least-squares slope of level over time once the cycle spans ≥ 3 h (rate ≥ 0;
 * a flat cycle gives 0 and no hours-left). null without readings.
 */
export function estimateDrain(readings: readonly BatteryReading[], now: Ms): DrainEstimate | null {
  const c = batteryCycle(readings);
  if (!c.length) return null;
  const first = c[0]!;
  const last = c[c.length - 1]!;
  let ratePerHour: number | null = null;
  if (c.length >= 2 && last.ts - first.ts >= DRAIN_MIN_SPAN_MS) {
    const xs = c.map((r) => (r.ts - first.ts) / HOUR);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = c.reduce((a, r) => a + r.level, 0) / c.length;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < c.length; i++) {
      sxy += (xs[i]! - mx) * (c[i]!.level - my);
      sxx += (xs[i]! - mx) ** 2;
    }
    ratePerHour = sxx > 0 ? Math.max(0, -sxy / sxx) : 0;
  }
  const sinceH = Math.max(0, (now - last.ts) / HOUR);
  const levelNow = ratePerHour ? Math.max(0, last.level - ratePerHour * sinceH) : last.level;
  const hoursLeft = ratePerHour && ratePerHour > 0 ? levelNow / ratePerHour : null;
  return { level: last.level, at: last.ts, levelNow, ratePerHour, hoursLeft, cycleStart: first.ts, readings: c.length };
}

/** Does this estimate call for "charge your Fitbit"? */
export function needsCharge(e: DrainEstimate): boolean {
  if (e.levelNow <= BATTERY_LOW) return true;
  if (e.hoursLeft !== null && e.hoursLeft < BATTERY_HOURS_LEFT) return true;
  return e.ratePerHour === null && e.levelNow <= BATTERY_LOW_NO_RATE;
}

/** "83 %, ~5 days left", "18 %, ~14 h left", "40 %" (no rate yet). */
export function batteryText(e: DrainEstimate): string {
  const pct = `${Math.round(e.levelNow)} %`;
  return e.hoursLeft === null ? pct : `${pct}, ~${hoursLeftText(e.hoursLeft)} left`;
}

export interface AlertDecision<S> {
  send: boolean;
  /** Why (for the function's JSON answer and the log). */
  reason: string;
  title?: string;
  body?: string;
  /** The state to store when `send` (unchanged otherwise). */
  state: S;
}

export interface BatteryAlertState {
  /** cycleStart of the cycle already alerted; null = none. */
  cycle: Ms | null;
}

/** Battery alert for one person: once per discharge cycle, 08:00–21:30 ICT. */
export function batteryAlert(i: { name: string; estimate: DrainEstimate | null; state: BatteryAlertState; now: Ms }): AlertDecision<BatteryAlertState> {
  const keep = (reason: string): AlertDecision<BatteryAlertState> => ({ send: false, reason, state: i.state });
  const e = i.estimate;
  if (!e) return keep('no battery readings');
  if (!needsCharge(e)) return keep(`fine: ${batteryText(e)}`);
  if (i.state.cycle === e.cycleStart) return keep('already sent for this charge');
  if (!inIctHours(i.now, BATTERY_HOURS)) return keep(`low (${batteryText(e)}); waiting for ${BATTERY_HOURS.from}`);
  const pct = Math.round(e.levelNow);
  return {
    send: true,
    reason: `low: ${batteryText(e)}`,
    title: `${i.name}’s Fitbit battery`,
    body: e.hoursLeft === null ? `Charge your Fitbit before bed — ${pct} %` : `Charge your Fitbit before bed — ${pct} %, about ${hoursLeftText(e.hoursLeft)} left`,
    state: { cycle: e.cycleStart },
  };
}

export interface StaleAlertState {
  /** The band's "last seen" time of the episode already alerted; null = none. */
  seenAt: Ms | null;
}

/**
 * Stale sync for one person: the band last reached Google (`seenAt` = greatest(device_last_sync_at, newest_point_at))
 * more than 6 h ago, the server's sync ran in the last 2 h (`checkedAt` = band_sync.last_sync_at), 08:00–22:00 ICT,
 * once per episode.
 */
export function staleAlert(i: {
  name: string;
  seenAt: Ms | null;
  checkedAt: Ms | null;
  /** band_sync.last_sync_ok of that run: false = the server's sync failed (e.g. Google sign-in expired), not the band. */
  checkOk?: boolean | null;
  state: StaleAlertState;
  now: Ms;
}): AlertDecision<StaleAlertState> {
  const keep = (reason: string): AlertDecision<StaleAlertState> => ({ send: false, reason, state: i.state });
  if (i.seenAt === null) return keep('band never synced');
  if (i.now - i.seenAt <= STALE_SYNC_MS) return keep(`synced ${whenText(i.seenAt, i.now)}`);
  if (i.checkOk === false) return keep('server sync failing (see System › Bands); not the band');
  if (i.checkedAt === null || i.now - i.checkedAt > SERVER_SYNC_FRESH_MS) return keep('server sync not running; not the band');
  if (i.state.seenAt === i.seenAt) return keep('already sent for this gap');
  if (!inIctHours(i.now, STALE_HOURS)) return keep(`stale; waiting for ${STALE_HOURS.from}`);
  return {
    send: true,
    reason: `no sync since ${whenText(i.seenAt, i.now)}`,
    title: 'Fitbit not syncing',
    body: `${i.name}’s Fitbit hasn’t synced since ${whenText(i.seenAt, i.now)} — open the Fitbit app`,
    state: { seenAt: i.seenAt },
  };
}

export interface ListenerAlertState {
  /** Night (wake date) already alerted; null = none. */
  night: string | null;
}

/** When the current stretch of "should be listening" began (alert_state 'listener_watch'); null = not listening. */
export interface ListenerWatch {
  since: Ms;
  night: string;
}

/**
 * The listening stretch after this tick: kept while listening goes on for the same night, started at `now` when
 * listening (re)starts (after a pause, a late arrival, a new night), null when not listening.
 */
export function nextListenerWatch(prev: ListenerWatch | null, listening: boolean, night: string, now: Ms): ListenerWatch | null {
  if (!listening) return null;
  if (prev && prev.night === night && prev.since <= now) return prev;
  return { since: now, night };
}

/**
 * Night listener: the Mac should be listening (`listening`, window from `from`) but the newest minute summary
 * (`lastMinute`, its start) is 10 min old or older, or none arrived 10 min into the window. Once per night.
 * `listeningSince` (start of the current listen=true stretch, see nextListenerWatch) moves the silence clock: after a
 * pause or a late arrival the Mac gets 10 min to resume before anyone is woken.
 */
export function listenerAlert(i: {
  listening: boolean;
  night: string;
  from: Ms;
  lastMinute: Ms | null;
  listeningSince?: Ms | null;
  macLabel: string;
  state: ListenerAlertState;
  now: Ms;
}): AlertDecision<ListenerAlertState> {
  const keep = (reason: string): AlertDecision<ListenerAlertState> => ({ send: false, reason, state: i.state });
  if (!i.listening) return keep('not listening now');
  const heard = i.lastMinute !== null && i.lastMinute >= i.from - 5 * MIN;
  // A minute row covers [ts, ts + 1 min): the listener went quiet at its end.
  const quietSince = heard ? i.lastMinute! + MIN : i.from;
  const clock = Math.max(quietSince, i.listeningSince ?? -Infinity);
  if (i.now - clock < LISTENER_SILENT_MS) {
    return keep(clock > quietSince ? `listening again since ${ictHm(clock)}` : heard ? `heard ${ictHm(i.lastMinute!)}` : 'window just started');
  }
  if (i.state.night === i.night) return keep('already sent tonight');
  return {
    send: true,
    reason: heard ? `quiet since ${ictHm(quietSince)}` : 'never started',
    title: 'Night listener',
    body: heard ? `Night listener stopped at ${ictHm(quietSince)} — check ${i.macLabel}` : `Night listener didn’t start at ${ictHm(i.from)} — check ${i.macLabel}`,
    state: { night: i.night },
  };
}

/** One person's battery level from band_sync.devices (pairedDevices): the tracker's, else the first numeric one. */
export function batteryFromDevices(devices: unknown): { level: number; ts: Ms | null } | null {
  if (!Array.isArray(devices)) return null;
  const found: { level: number; ts: Ms | null; tracker: boolean }[] = [];
  for (const d of devices) {
    if (!d || typeof d !== 'object') continue;
    const o = d as Record<string, unknown>;
    const b = o.batteryLevel;
    const n = typeof b === 'number' ? b : typeof b === 'string' && b.trim() !== '' ? Number(b) : NaN;
    if (!Number.isFinite(n) || n < 0 || n > 100) continue;
    const t = typeof o.lastSyncTime === 'string' ? Date.parse(o.lastSyncTime) : NaN;
    found.push({ level: n, ts: Number.isFinite(t) ? t : null, tracker: o.deviceType === 'TRACKER' });
  }
  const pick = found.find((f) => f.tracker) ?? found[0];
  return pick ? { level: pick.level, ts: pick.ts } : null;
}
