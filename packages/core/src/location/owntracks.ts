// OwnTracks HTTP-mode messages (iOS / Android app → `owntracks` Edge Function → public.locations, migration 0023).
//
// The phone POSTs one JSON message, or an array of them, per request. Only two kinds are stored:
//   - _type 'location':   {lat, lon, tst (epoch SECONDS), acc, alt, vel (km/h), cog, batt, conn ('w'|'m'|'o'),
//                          SSID, t (trigger: p ping, c region, r report, u manual, t timer, v monitoring …), inregions}
//   - _type 'transition': {event 'enter'|'leave', desc (region name), tst, lat, lon, acc} (region monitoring)
// 'waypoint' / 'waypoints' (region definitions), 'lwt' and every other type are recognised and ignored.
// A message is refused ('invalid') when lat/lon are missing, not finite or out of range, or tst is more than 1 day in
// the future or older than 400 days. Optional numbers outside their range (acc < 0, batt > 100, cog -1 …) are dropped,
// not fatal: OwnTracks sends -1 for "unknown" on some devices.
import type { Ms } from '../types.ts';

const DAY = 86_400_000;

export const OWNTRACKS_MAX_FUTURE_MS = DAY;
export const OWNTRACKS_MAX_AGE_MS = 400 * DAY;
/** At most this many messages are read from one request (a phone flushing its queue sends a few hundred at most). */
export const OWNTRACKS_MAX_MESSAGES = 1000;

/** A normalised location fix. ts in epoch ms (OwnTracks tst is seconds). */
export interface Fix {
  ts: Ms;
  lat: number;
  lon: number;
  accM?: number;
  altM?: number;
  velKmh?: number;
  cog?: number;
  batt?: number;
  conn?: 'w' | 'm' | 'o';
  ssid?: string;
  trigger?: string;
  regions?: string[];
}

export interface Transition {
  event: 'enter' | 'leave';
  /** The region's name (OwnTracks `desc`), trimmed; '' when the phone sent none. */
  region: string;
  ts: Ms;
  lat: number;
  lon: number;
  accM?: number;
}

export type OwnTracksMessage =
  | { kind: 'location'; fix: Fix }
  | { kind: 'transition'; transition: Transition }
  | { kind: 'waypoint' | 'waypoints' | 'lwt' }
  | { kind: 'other'; type: string }
  | { kind: 'invalid'; type: string; reason: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
/** Rounded integer within [lo, hi], else undefined. */
const intIn = (v: unknown, lo: number, hi: number): number | undefined => {
  const x = num(v);
  if (x === null) return undefined;
  const r = Math.round(x);
  return r >= lo && r <= hi ? r : undefined;
};
const str = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined;
  // No control characters; trimmed and capped.
  const s = v.replace(/\p{Cc}/gu, '').trim();
  return s ? s.slice(0, max) : undefined;
};

function position(m: Obj, now: Ms): { ts: Ms; lat: number; lon: number } | string {
  const lat = num(m.lat);
  const lon = num(m.lon);
  if (lat === null || lon === null) return 'lat/lon missing';
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return 'lat/lon out of range';
  const tst = num(m.tst);
  if (tst === null || tst <= 0) return 'tst missing';
  const ts = Math.round(tst * 1000);
  if (ts > now + OWNTRACKS_MAX_FUTURE_MS) return 'tst more than 1 day in the future';
  if (ts < now - OWNTRACKS_MAX_AGE_MS) return 'tst older than 400 days';
  return { ts, lat, lon };
}

/** One message. `now` is the server clock (epoch ms). */
export function parseOwnTracksMessage(raw: unknown, now: Ms): OwnTracksMessage {
  if (!isObj(raw)) return { kind: 'invalid', type: '', reason: 'not an object' };
  const type = typeof raw._type === 'string' ? raw._type : '';
  if (type === 'waypoint' || type === 'waypoints' || type === 'lwt') return { kind: type };
  if (type !== 'location' && type !== 'transition') return { kind: 'other', type: type.slice(0, 40) };
  const pos = position(raw, now);
  if (typeof pos === 'string') return { kind: 'invalid', type, reason: pos };
  const accM = intIn(raw.acc, 0, 1_000_000);

  if (type === 'transition') {
    const event = raw.event === 'enter' || raw.event === 'leave' ? raw.event : null;
    if (!event) return { kind: 'invalid', type, reason: 'event must be enter or leave' };
    const t: Transition = { event, region: str(raw.desc, 100) ?? '', ...pos };
    if (accM !== undefined) t.accM = accM;
    return { kind: 'transition', transition: t };
  }

  const fix: Fix = { ...pos };
  if (accM !== undefined) fix.accM = accM;
  const alt = intIn(raw.alt, -1000, 100_000);
  if (alt !== undefined) fix.altM = alt;
  const vel = intIn(raw.vel, 0, 2000);
  if (vel !== undefined) fix.velKmh = vel;
  const cog = intIn(raw.cog, 0, 360);
  if (cog !== undefined) fix.cog = cog;
  const batt = intIn(raw.batt, 0, 100);
  if (batt !== undefined) fix.batt = batt;
  if (raw.conn === 'w' || raw.conn === 'm' || raw.conn === 'o') fix.conn = raw.conn;
  const ssid = str(raw.SSID ?? raw.ssid, 64);
  if (ssid) fix.ssid = ssid;
  const trigger = str(raw.t, 8);
  if (trigger) fix.trigger = trigger;
  if (Array.isArray(raw.inregions)) {
    const regions = raw.inregions.map((r) => str(r, 100)).filter((r): r is string => !!r).slice(0, 20);
    if (regions.length) fix.regions = regions;
  }
  return { kind: 'location', fix };
}

/** The request body: one message object or an array of them (at most OWNTRACKS_MAX_MESSAGES are read). */
export function parseOwnTracks(body: unknown, now: Ms): OwnTracksMessage[] {
  const list = Array.isArray(body) ? body.slice(0, OWNTRACKS_MAX_MESSAGES) : [body];
  return list.map((m) => parseOwnTracksMessage(m, now));
}

/** Row for public.locations (snake_case; source 'owntracks'). */
export function locationRow(personId: string, m: { fix: Fix } | { transition: Transition }): Record<string, unknown> {
  if ('transition' in m) {
    const t = m.transition;
    return {
      person_id: personId,
      ts: new Date(t.ts).toISOString(),
      lat: t.lat,
      lon: t.lon,
      acc_m: t.accM ?? null,
      event: t.event,
      note: t.region || null,
      source: 'owntracks',
    };
  }
  const f = m.fix;
  return {
    person_id: personId,
    ts: new Date(f.ts).toISOString(),
    lat: f.lat,
    lon: f.lon,
    acc_m: f.accM ?? null,
    alt_m: f.altM ?? null,
    vel_kmh: f.velKmh ?? null,
    cog: f.cog ?? null,
    batt: f.batt ?? null,
    conn: f.conn ?? null,
    ssid: f.ssid ?? null,
    trigger: f.trigger ?? null,
    regions: f.regions ?? null,
    source: 'owntracks',
  };
}
