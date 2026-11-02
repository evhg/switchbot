// Geometry for the location features (OwnTracks fixes in public.locations, migration 0023): distances, the home/away
// rule the `owntracks` Edge Function applies to each fix, and the track helpers the PWA's Map timelapse draws with.
//
// Pure: no clock is read here (pass `t` / `now`). Tracks are arrays of TrackPoint sorted by ts (oldest first);
// positions between two points are interpolated linearly in time, never across a gap longer than maxGapMs (default
// 30 min), so a phone that went quiet is shown where it was last seen ("stale"), not sliding across the map. A longer
// gap whose two ends are within STATIONARY_M of each other is the phone sitting still (OwnTracks "Significant" mode
// sends nothing while stationary), so it is bridged: fresh, not stale, and counted by togetherSpans.
import type { Ms } from '../types.ts';

const MIN = 60_000;
const EARTH_R_M = 6_371_008.8;

/** One point of a person's track (epoch ms, WGS84 degrees, horizontal accuracy in metres when known). */
export type TrackPoint = { ts: number; lat: number; lon: number; accM?: number | null };

/** Positions this far apart in time are not interpolated (the phone was quiet in between). */
export const DEFAULT_MAX_GAP_MS = 30 * MIN;
/** A gap of any length whose two ends are this close counts as "stayed put" (bridged, not stale). */
export const STATIONARY_M = 50;
/** Two people closer than this are "together". */
export const TOGETHER_WITHIN_M = 150;
/** Fixes less accurate than this never change home/away. */
export const HOME_MAX_ACC_M = 1000;
/** Default radius of the home circle (household_settings.home_radius_m). */
export const DEFAULT_HOME_RADIUS_M = 150;

/** Great-circle distance in metres (haversine, mean Earth radius). */
export function haversineM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface HomePoint {
  lat: number;
  lon: number;
  radiusM: number;
}

/**
 * Home/away from one fix, with hysteresis so a fix wobbling around the edge of the circle never flips the state:
 *   - 'home'  when the fix is inside the radius and accurate enough (acc ≤ max(2 × radius, 250 m)); a person already
 *             'home' (prev) stays home on an inside fix of any accuracy up to HOME_MAX_ACC_M;
 *   - 'away'  when it is farther than radius + max(150 m, acc) from home;
 *   - null    otherwise (the band in between, or acc > 1000 m): no change, keep whatever the state was.
 * A fix without an accuracy counts as accurate.
 */
export function homeState(
  fix: { lat: number; lon: number; accM?: number | null },
  home: HomePoint,
  prev: 'home' | 'away' | null,
): 'home' | 'away' | null {
  const acc = fix.accM ?? 0;
  if (!Number.isFinite(acc) || acc > HOME_MAX_ACC_M) return null;
  const r = Math.max(1, home.radiusM);
  const d = haversineM(fix, home);
  if (d <= r && (acc <= Math.max(r * 2, 250) || prev === 'home')) return 'home';
  if (d > r + Math.max(150, acc)) return 'away';
  return null;
}

/** An OwnTracks region that means home ("Home", "thuis", "huis", "house"; any case, trimmed). */
export function isHomeRegion(name: unknown): boolean {
  return typeof name === 'string' && /^(home|thuis|huis|house)$/i.test(name.trim());
}

/** Index of the last point with ts <= t, or -1. */
function lastAtOrBefore(track: readonly TrackPoint[], t: number): number {
  let lo = 0;
  let hi = track.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (track[mid]!.ts <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;

/** Two consecutive points between which positions are interpolated: close in time, or the phone stayed put. */
const bridged = (p: TrackPoint, q: TrackPoint, maxGapMs: number) => q.ts - p.ts <= maxGapMs || haversineM(p, q) <= STATIONARY_M;

/**
 * Where the person was at `t`. Null before the first point (or for an empty track). Between two points less than
 * maxGapMs apart, or any distance in time but within STATIONARY_M of each other: interpolated, ts = t, stale false.
 * Otherwise (after the last point, or inside a longer gap): the last
 * known point with its own ts, stale when it is more than maxGapMs older than t.
 */
export function positionAt(
  track: readonly TrackPoint[],
  t: number,
  maxGapMs: number = DEFAULT_MAX_GAP_MS,
): { lat: number; lon: number; ts: number; stale: boolean } | null {
  const i = lastAtOrBefore(track, t);
  if (i < 0) return null;
  const p = track[i]!;
  if (p.ts === t) return { lat: p.lat, lon: p.lon, ts: t, stale: false };
  const q = track[i + 1];
  if (q && bridged(p, q, maxGapMs)) {
    const f = q.ts === p.ts ? 0 : (t - p.ts) / (q.ts - p.ts);
    return { lat: lerp(p.lat, q.lat, f), lon: lerp(p.lon, q.lon, f), ts: t, stale: false };
  }
  return { lat: p.lat, lon: p.lon, ts: p.ts, stale: t - p.ts > maxGapMs };
}

/** The track drawn so far at `t`: every point with ts <= t, plus the interpolated point at t (for a growing polyline). */
export function trackUpTo(track: readonly TrackPoint[], t: number): TrackPoint[] {
  const i = lastAtOrBefore(track, t);
  if (i < 0) return [];
  const out = track.slice(0, i + 1);
  const p = track[i]!;
  const q = track[i + 1];
  if (q && p.ts < t) {
    const f = (t - p.ts) / (q.ts - p.ts);
    out.push({ ts: t, lat: lerp(p.lat, q.lat, f), lon: lerp(p.lon, q.lon, f) });
  }
  return out;
}

/**
 * Time spans in which both people were within `withinM` (150 m) of each other, judged on interpolated positions every
 * `stepMs` (1 min) plus at every point of either track. Moments where either track is stale (a gap > maxGapMs that is
 * not a stationary one, or outside the track) never count. Spans are [{from, to}] (epoch ms), sorted, non-overlapping.
 */
export function togetherSpans(
  a: readonly TrackPoint[],
  b: readonly TrackPoint[],
  opts: { maxGapMs?: number; withinM?: number; stepMs?: number } = {},
): { from: number; to: number }[] {
  const maxGapMs = opts.maxGapMs ?? DEFAULT_MAX_GAP_MS;
  const withinM = opts.withinM ?? TOGETHER_WITHIN_M;
  const stepMs = Math.max(1000, opts.stepMs ?? MIN);
  if (!a.length || !b.length) return [];
  const start = Math.max(a[0]!.ts, b[0]!.ts);
  const end = Math.min(a[a.length - 1]!.ts, b[b.length - 1]!.ts);
  if (end < start) return [];
  const times = new Set<number>();
  for (let t = start; t < end; t += stepMs) times.add(t);
  times.add(end);
  for (const p of a) if (p.ts >= start && p.ts <= end) times.add(p.ts);
  for (const p of b) if (p.ts >= start && p.ts <= end) times.add(p.ts);
  const sorted = [...times].sort((x, y) => x - y);

  const spans: { from: number; to: number }[] = [];
  let open: { from: number; to: number } | null = null;
  for (const t of sorted) {
    const pa = positionAt(a, t, maxGapMs);
    const pb = positionAt(b, t, maxGapMs);
    const ok = !!pa && !!pb && pa.ts === t && pb.ts === t && !pa.stale && !pb.stale && haversineM(pa, pb) <= withinM;
    if (ok) {
      if (open) open.to = t;
      else open = { from: t, to: t };
    } else if (open) {
      spans.push(open);
      open = null;
    }
  }
  if (open) spans.push(open);
  return spans;
}

/** Latest fixes of two people: together when < withinM apart and the fixes are within maxGapMs of each other. */
export function together(
  a: { lat: number; lon: number; ts: Ms } | null | undefined,
  b: { lat: number; lon: number; ts: Ms } | null | undefined,
  opts: { maxGapMs?: number; withinM?: number } = {},
): { together: boolean; distanceM: number } | null {
  if (!a || !b) return null;
  const distanceM = haversineM(a, b);
  const close = Math.abs(a.ts - b.ts) <= (opts.maxGapMs ?? DEFAULT_MAX_GAP_MS);
  return { together: close && distanceM < (opts.withinM ?? TOGETHER_WITHIN_M), distanceM };
}
