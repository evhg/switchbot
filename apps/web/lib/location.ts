'use client';
/**
 * Where everyone is (Map, System › Location): reads public.locations (migration 0023, written by the owntracks Edge
 * Function from each iPhone's OwnTracks app) and the household's location settings in household_settings.
 *
 *   useLocationSettings(enabled, nonce)   home point + radius, the Google Maps browser key, camera_ticket_required,
 *                                         presence_people (whose phones decide home / away; migration 0031)
 *   reportsSelf / leaderOf / phonesLabel  presence_people helpers: Cath "follows Erik's phone" when it is {b}
 *   trailPoints(fixes)                    a track for drawing: GPS jitter merged, rough fixes (> 100 m) left out
 *   useLatestFixes(enabled, nonce)        each person's newest fix (null = none yet); undefined while loading
 *   fetchTracks(from, to)                 both people's fixes in [from, to], acc ≤ 500 m or unknown, oldest first,
 *                                         each with its last fix before `from` as an anchor; paged past PostgREST's
 *                                         1000-row limit, newest kept (trimmed: true) past maxRows
 *   setHomeLocation / setMapsKey          the writers' RPCs (owner / member); each returns an error message or null
 *   sampleFixes / sampleTracks            plausible data for the simulator (central Bangkok), so the page is never empty
 *
 * Track math (positionAt, trackUpTo, togetherSpans, haversineM) lives in @sleep-lab/core (src/location).
 */
import { useEffect, useState } from 'react';
import { haversineM, type TrackPoint } from '@sleep-lab/core';
import { functionsUrl, supabaseClient, supabaseConfigured } from './data/supabase.ts';
import { HOUR, MIN } from './format.ts';

type Row = Record<string, unknown>;

/** The phone app posts here (supabase/functions/owntracks). */
export const OWNTRACKS_URL_DEFAULT = 'https://vaelokyqjdsxveqvdtbo.supabase.co/functions/v1/owntracks';
export const owntracksUrl = () => (supabaseConfigured() ? `${functionsUrl()}/owntracks` : OWNTRACKS_URL_DEFAULT);

/** Fixes worse than this are left out of the timelapse (the query's acc_m filter). */
export const TRACK_MAX_ACC_M = 500;
/** "Sending" in System › Location: a fix in the last 2 h. */
export const SENDING_MS = 2 * HOUR;
/** Two people are "together" within this distance (and with fixes at most TOGETHER_SKEW_MS apart). */
export const TOGETHER_M = 150;
export const TOGETHER_SKEW_MS = 30 * MIN;
export const HOME_RADII = [100, 150, 250, 400] as const;

/** Names when the dataset has none (household people 'a' and 'b'). */
export const FALLBACK_NAMES: Record<string, string> = { a: 'Cath', b: 'Erik' };
export const PERSON_IDS = ['a', 'b'] as const;

export interface Home {
  lat: number;
  lon: number;
  radiusM: number;
}

export interface LocationSettings {
  home: Home | null;
  /** household_settings.maps_browser_key: a browser key restricted to this site's referrer. */
  mapsKey: string | null;
  cameraTicketRequired: boolean;
  /** household_settings.presence_people (migration 0031): the people whose phones decide home / away. The others
   *  follow them (public.presence_latest, 0032): Cath and Erik are always together, only Erik's phone reports.
   *  null = everyone reports for themselves (also before the migration). */
  presencePeople: string[] | null;
}

export interface Fix extends TrackPoint {
  personId: string;
  batt: number | null;
  /** 'w' Wi-Fi, 'm' mobile data, 'o' offline. */
  conn: string | null;
  ssid: string | null;
  sample?: boolean;
}

const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN);
const numOrNull = (v: unknown) => (Number.isFinite(num(v)) ? num(v) : null);
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

/** A server message that means "migration 0023 isn't applied yet". */
const missing = (m: string) => /does not exist|schema cache|could not find/i.test(m);
export const NOT_YET = 'Location isn’t on the server yet (migration 0023).';

function toFix(r: Row): Fix {
  return {
    personId: String(r.person_id),
    ts: Date.parse(String(r.ts)),
    lat: num(r.lat),
    lon: num(r.lon),
    accM: numOrNull(r.acc_m),
    batt: numOrNull(r.batt),
    conn: str(r.conn),
    ssid: str(r.ssid),
  };
}

function toSettings(r: Row | null): LocationSettings {
  const lat = numOrNull(r?.home_lat);
  const lon = numOrNull(r?.home_lon);
  return {
    home: lat !== null && lon !== null ? { lat, lon, radiusM: numOrNull(r?.home_radius_m) ?? 150 } : null,
    mapsKey: str(r?.maps_browser_key),
    cameraTicketRequired: r?.camera_ticket_required === true,
    presencePeople: Array.isArray(r?.presence_people) && r.presence_people.length ? (r.presence_people as unknown[]).map(String) : null,
  };
}

const EMPTY: LocationSettings = { home: null, mapsKey: null, cameraTicketRequired: false, presencePeople: null };

/** Does this person's own phone decide their home / away (and show them on the Map)? */
export const reportsSelf = (id: string, presencePeople: readonly string[] | null | undefined) => !presencePeople?.length || presencePeople.includes(id);
/** Whose phone this person follows (the first of presence_people), or null when they report for themselves. */
export const leaderOf = (id: string, presencePeople: readonly string[] | null | undefined): string | null =>
  reportsSelf(id, presencePeople) ? null : (presencePeople?.[0] ?? null);
/** "Erik’s phone" / "Erik’s and Cath’s phones" for presence_people. */
export function phonesLabel(ids: readonly string[], nameOf: (id: string) => string): string {
  const ns = ids.map((id) => `${nameOf(id)}’s`);
  return ns.length <= 1 ? `${ns[0] ?? 'the'} phone` : `${ns.slice(0, -1).join(', ')} and ${ns.at(-1)} phones`;
}

/** household_settings' location columns; undefined while loading. Not a member: the empty settings. */
export function useLocationSettings(enabled: boolean, nonce = 0): { settings: LocationSettings | undefined; error: string | null } {
  const [res, setRes] = useState<{ settings: LocationSettings | undefined; error: string | null }>({ settings: undefined, error: null });
  useEffect(() => {
    if (!enabled) return setRes({ settings: EMPTY, error: null });
    let alive = true;
    supabaseClient()
      .from('household_settings')
      // '*' so a database without one of the newer columns (presence_people, 0031) still loads.
      .select('*')
      .eq('id', 1)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!alive) return;
        if (error) return setRes({ settings: EMPTY, error: missing(error.message) || /home_lat|maps_browser_key|camera_ticket/.test(error.message) ? NOT_YET : error.message });
        setRes({ settings: toSettings(data as Row | null), error: null });
      });
    return () => {
      alive = false;
    };
  }, [enabled, nonce]);
  return res;
}

/** Trail drawing: fixes rougher than this are left out of the line (the marker still uses them). */
export const TRAIL_MAX_ACC_M = 100;
/** Trail drawing: a fix closer than max(its accuracy, this) to the previous kept one is GPS jitter, not a move. */
export const TRAIL_MIN_STEP_M = 25;

/**
 * A track for drawing (oldest first in, oldest first out): fixes with acc > TRAIL_MAX_ACC_M are dropped, and a fix
 * within max(acc, TRAIL_MIN_STEP_M) of the previous kept fix is merged into it (its time is kept, the position is not),
 * so a phone lying still at home is one point, not a little polygon of jitter. The last fix always moves the tip when
 * it is a real step; otherwise the cluster's first point stands for it.
 */
export function trailPoints<T extends TrackPoint>(track: readonly T[]): T[] {
  const out: T[] = [];
  for (const f of track) {
    if (f.accM != null && f.accM > TRAIL_MAX_ACC_M) continue;
    const prev = out.at(-1);
    if (prev && haversineM(prev, f) < Math.max(f.accM ?? 0, prev.accM ?? 0, TRAIL_MIN_STEP_M)) continue;
    out.push(f);
  }
  return out;
}

const FIX_COLS = 'person_id,ts,lat,lon,acc_m,batt,conn,ssid';

/** Each person's newest fix (by person id); undefined while loading. */
export function useLatestFixes(enabled: boolean, nonce = 0): { fixes: Record<string, Fix | null> | undefined; error: string | null } {
  const [res, setRes] = useState<{ fixes: Record<string, Fix | null> | undefined; error: string | null }>({ fixes: undefined, error: null });
  useEffect(() => {
    let alive = true;
    if (!enabled) {
      setRes({ fixes: sampleFixes(), error: null });
      return;
    }
    const c = supabaseClient();
    Promise.all(PERSON_IDS.map((id) => c.from('locations').select(FIX_COLS).eq('person_id', id).order('ts', { ascending: false }).limit(1).maybeSingle())).then((rs) => {
      if (!alive) return;
      const err = rs.find((r) => r.error)?.error;
      // A failed refresh keeps the fixes already shown (a flaky connection shouldn't blank the map).
      if (err) return setRes((prev) => ({ fixes: prev.fixes ?? {}, error: missing(err.message) ? NOT_YET : err.message }));
      const fixes: Record<string, Fix | null> = {};
      PERSON_IDS.forEach((id, i) => {
        const row = rs[i]!.data as Row | null;
        fixes[id] = row ? toFix(row) : null;
      });
      // Keep the previous object when nothing changed, so a 60 s refresh doesn't refit the map.
      setRes((prev) => (prev.fixes && sameFixes(prev.fixes, fixes) ? prev : { fixes, error: null }));
    });
    return () => {
      alive = false;
    };
  }, [enabled, nonce]);
  return res;
}

const sameFixes = (a: Record<string, Fix | null>, b: Record<string, Fix | null>) => PERSON_IDS.every((id) => (a[id]?.ts ?? null) === (b[id]?.ts ?? null) && a[id]?.batt === b[id]?.batt);

export interface Tracks {
  /** Per person, oldest first. Each starts with that person's last fix before `from` (when there is one), so the
   *  timelapse has a position from the first moment even if the phone stayed put and sent nothing in the range. */
  tracks: Record<string, Fix[]>;
  /** More than maxRows fixes in the range: the oldest ones were left out (the newest maxRows are kept). */
  trimmed: boolean;
}

/** Both people's fixes in [from, to] (plus each one's anchor before `from`), grouped by person. Throws with a readable message. */
export async function fetchTracks(from: number, to: number, maxRows = 40_000): Promise<Tracks> {
  const c = supabaseClient();
  const fromIso = new Date(from).toISOString();
  const rows: Row[] = [];
  const PAGE = 1000;
  let trimmed = false;
  // Newest first, so a cut (very long range in "Move" mode) drops the oldest part, not the most recent.
  for (let i = 0; ; i += PAGE) {
    if (i >= maxRows) {
      trimmed = true;
      break;
    }
    const { data, error } = await c
      .from('locations')
      .select(FIX_COLS)
      .gte('ts', fromIso)
      .lte('ts', new Date(to).toISOString())
      .or(`acc_m.is.null,acc_m.lte.${TRACK_MAX_ACC_M}`)
      .order('ts', { ascending: false })
      .order('person_id', { ascending: true })
      .range(i, i + PAGE - 1);
    if (error) throw new Error(missing(error.message) ? NOT_YET : error.message);
    const page = (data ?? []) as Row[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  const out: Record<string, Fix[]> = {};
  for (const id of PERSON_IDS) out[id] = [];
  if (!trimmed) {
    // Each person's last fix before the range: where they were at `from`.
    const anchors = await Promise.all(
      PERSON_IDS.map((id) =>
        c
          .from('locations')
          .select(FIX_COLS)
          .eq('person_id', id)
          .lt('ts', fromIso)
          .or(`acc_m.is.null,acc_m.lte.${TRACK_MAX_ACC_M}`)
          .order('ts', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ),
    );
    for (const a of anchors) {
      if (a.error) throw new Error(missing(a.error.message) ? NOT_YET : a.error.message);
      if (a.data) rows.push(a.data as Row);
    }
  }
  for (const r of rows) {
    const f = toFix(r);
    if (Number.isFinite(f.lat) && Number.isFinite(f.lon) && Number.isFinite(f.ts)) (out[f.personId] ??= []).push(f);
  }
  for (const id of Object.keys(out)) out[id]!.sort((x, y) => x.ts - y.ts);
  return { tracks: out, trimmed };
}

function rpcError(message: string): string {
  if (/could not find the function|does not exist/i.test(message)) return NOT_YET;
  if (/not allowed|permission|denied/i.test(message)) return 'Your household role is read-only.';
  return message;
}

/** Sets (or with nulls clears) the household's home point (set_home_location, migration 0023). */
export async function setHomeLocation(lat: number | null, lon: number | null, radiusM: number): Promise<string | null> {
  const { error } = await supabaseClient().rpc('set_home_location', { p_lat: lat, p_lon: lon, p_radius_m: radiusM });
  return error ? rpcError(error.message) : null;
}

/** Saves (or with null clears) the Google Maps browser key (set_maps_browser_key, migration 0023). */
export async function setMapsKey(key: string | null): Promise<string | null> {
  const { error } = await supabaseClient().rpc('set_maps_browser_key', { p_key: key });
  if (error && /invalid|check|format/i.test(error.message)) return 'That doesn’t look like a Maps key (letters, digits, - and _, 20 to 100 characters).';
  return error ? rpcError(error.message) : null;
}

/** "Wi-Fi · Home-5G", "Mobile data", "Offline" or null. */
export function connLabel(f: Pick<Fix, 'conn' | 'ssid'>): string | null {
  if (f.conn === 'w') return f.ssid ? `Wi-Fi · ${f.ssid}` : 'Wi-Fi';
  if (f.conn === 'm') return 'Mobile data';
  if (f.conn === 'o') return 'Offline';
  return null;
}

/** "1.2 km", "350 m". */
export function distLabel(m: number): string {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return m < 10_000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 1000)} km`;
}

// ───────────────────────────────────────── simulator ─────────────────────────────────────────

/** Sample home for the simulator: a park in central Bangkok, not anyone's address. */
export const SAMPLE_HOME: Home = { lat: 13.7307, lon: 100.5418, radiusM: 150 };

/** Deterministic sample day for one person: home, out on a loop and back. Points every 5 min. */
function sampleDay(personId: string, from: number, to: number): Fix[] {
  const out: Fix[] = [];
  const b = personId === 'b';
  const step = 5 * MIN;
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) {
    const h = ((t / HOUR + 7) % 24 + 24) % 24; // ICT hour of day
    // Out 09:00–17:30 (Erik 10:00–19:00) on a loop of ~3–5 km; home otherwise. Together for lunch 12:00–13:30.
    const [h0, h1] = b ? [10, 19] : [9, 17.5];
    let lat = SAMPLE_HOME.lat;
    let lon = SAMPLE_HOME.lon;
    if (h >= h0 && h < h1) {
      const lunch = h >= 12 && h < 13.5;
      const p = (h - h0) / (h1 - h0);
      const r = b ? 0.04 : 0.028;
      const a = p * Math.PI * 2 + (b ? 1.3 : 0);
      lat = lunch ? 13.7466 : SAMPLE_HOME.lat + r * Math.sin(a) * Math.min(1, p * 6, (1 - p) * 6);
      lon = lunch ? 100.5393 : SAMPLE_HOME.lon + r * 1.3 * (1 - Math.cos(a)) * 0.5 * Math.min(1, p * 6, (1 - p) * 6);
    }
    const j = Math.sin(t / 7919 + (b ? 2 : 0)) * 0.0002;
    out.push({ personId, ts: t, lat: lat + j, lon: lon - j, accM: 12, batt: Math.round(95 - ((h * 3) % 60)), conn: h >= h0 && h < h1 ? 'm' : 'w', ssid: h >= h0 && h < h1 ? null : 'Home', sample: true });
  }
  return out;
}

export function sampleTracks(from: number, to: number): Record<string, Fix[]> {
  return { a: sampleDay('a', from, to), b: sampleDay('b', from, to) };
}

export function sampleFixes(now = Date.now()): Record<string, Fix | null> {
  const t = sampleTracks(now - 15 * MIN, now);
  return { a: t.a!.at(-1) ?? null, b: t.b!.at(-3) ?? null };
}
