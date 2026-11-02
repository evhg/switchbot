import { describe, expect, it } from 'vitest';
import {
  haversineM,
  homeState,
  isHomeRegion,
  locationRow,
  parseOwnTracks,
  positionAt,
  together,
  togetherSpans,
  trackUpTo,
  type TrackPoint,
} from '../src/index.ts';

const MIN = 60_000;
const NOW = Date.parse('2026-11-02T14:05:00+07:00');
const TST = Math.floor(NOW / 1000) - 60;
const HOME = { lat: 7.8804, lon: 98.3923, radiusM: 150 };
/** A point `m` metres north of home. */
const north = (m: number) => ({ lat: HOME.lat + m / 111_195, lon: HOME.lon });

describe('haversineM', () => {
  it('measures metres on the sphere', () => {
    expect(haversineM(HOME, HOME)).toBe(0);
    expect(haversineM(HOME, north(1000))).toBeCloseTo(1000, 0);
    // Phuket → Bangkok, about 685 km.
    expect(haversineM({ lat: 7.88, lon: 98.39 }, { lat: 13.7563, lon: 100.5018 }) / 1000).toBeGreaterThan(680);
    expect(haversineM({ lat: 7.88, lon: 98.39 }, { lat: 13.7563, lon: 100.5018 }) / 1000).toBeLessThan(700);
  });
});

describe('homeState', () => {
  it('home inside the radius with a decent fix, away well outside, null in the band', () => {
    expect(homeState({ ...north(50), accM: 20 }, HOME, null)).toBe('home');
    expect(homeState({ ...north(140), accM: 300 }, HOME, 'away')).toBe('home'); // ≤ max(300, 250)
    expect(homeState({ ...north(140), accM: 400 }, HOME, 'away')).toBeNull();
    expect(homeState({ ...north(140), accM: 400 }, HOME, 'home')).toBe('home');
    expect(homeState({ ...north(250), accM: 20 }, HOME, 'home')).toBeNull(); // 150 < d ≤ 300
    expect(homeState({ ...north(310), accM: 20 }, HOME, 'home')).toBe('away');
    expect(homeState({ ...north(500), accM: 400 }, HOME, 'home')).toBeNull(); // margin = acc 400 → needs > 550
    expect(homeState({ ...north(600), accM: 400 }, HOME, 'home')).toBe('away');
    expect(homeState({ ...north(50), accM: 1500 }, HOME, null)).toBeNull();
    expect(homeState(north(50), HOME, null)).toBe('home');
  });
  it('recognises home region names', () => {
    expect(isHomeRegion(' Home ')).toBe(true);
    expect(isHomeRegion('thuis')).toBe(true);
    expect(isHomeRegion('HUIS')).toBe(true);
    expect(isHomeRegion('house')).toBe(true);
    expect(isHomeRegion('Home office')).toBe(false);
    expect(isHomeRegion(null)).toBe(false);
  });
});

describe('parseOwnTracks', () => {
  const loc = { _type: 'location', lat: 7.88, lon: 98.39, tst: TST, acc: 12.4, alt: 8, vel: 0, cog: -1, batt: 87, conn: 'w', SSID: 'Home5G', t: 'u', inregions: ['Home'], tid: 'C' };
  it('normalises a location', () => {
    const [m] = parseOwnTracks(loc, NOW);
    expect(m).toEqual({
      kind: 'location',
      fix: { ts: TST * 1000, lat: 7.88, lon: 98.39, accM: 12, altM: 8, velKmh: 0, batt: 87, conn: 'w', ssid: 'Home5G', trigger: 'u', regions: ['Home'] },
    });
    expect(m && m.kind === 'location' && locationRow('a', m)).toMatchObject({ person_id: 'a', acc_m: 12, cog: null, regions: ['Home'], source: 'owntracks' });
  });
  it('handles arrays, transitions and ignored types', () => {
    const out = parseOwnTracks(
      [
        loc,
        { _type: 'transition', event: 'leave', desc: 'Home', tst: TST, lat: 7.88, lon: 98.39, acc: 30 },
        { _type: 'waypoints', waypoints: [] },
        { _type: 'lwt', tst: TST },
        { _type: 'status' },
        'junk',
      ],
      NOW,
    );
    expect(out.map((m) => m.kind)).toEqual(['location', 'transition', 'waypoints', 'lwt', 'other', 'invalid']);
    const t = out[1]!;
    expect(t.kind === 'transition' && t.transition).toEqual({ event: 'leave', region: 'Home', ts: TST * 1000, lat: 7.88, lon: 98.39, accM: 30 });
    expect(t.kind === 'transition' && locationRow('b', t)).toMatchObject({ event: 'leave', note: 'Home', person_id: 'b' });
  });
  it('refuses bad coordinates and timestamps', () => {
    const bad = (o: object) => parseOwnTracks({ ...loc, ...o }, NOW)[0]!.kind;
    expect(bad({ lat: 91 })).toBe('invalid');
    expect(bad({ lon: -181 })).toBe('invalid');
    expect(bad({ lat: Number.NaN })).toBe('invalid');
    expect(bad({ lat: undefined })).toBe('invalid');
    expect(bad({ tst: TST + 2 * 86_400 })).toBe('invalid');
    expect(bad({ tst: TST - 401 * 86_400 })).toBe('invalid');
    expect(bad({ tst: TST - 399 * 86_400 })).toBe('location');
    expect(parseOwnTracks({ _type: 'transition', event: 'wander', tst: TST, lat: 1, lon: 1 }, NOW)[0]!.kind).toBe('invalid');
  });
});

describe('tracks', () => {
  const T0 = NOW - 60 * MIN;
  const track: TrackPoint[] = [
    { ts: T0, lat: 0, lon: 0 },
    { ts: T0 + 10 * MIN, lat: 0, lon: 1 },
    { ts: T0 + 60 * MIN, lat: 0, lon: 2 }, // 50-min gap
  ];
  it('positionAt interpolates, holds across gaps and marks stale', () => {
    expect(positionAt(track, T0 - 1)).toBeNull();
    expect(positionAt([], T0)).toBeNull();
    expect(positionAt(track, T0 + 5 * MIN)).toEqual({ lat: 0, lon: 0.5, ts: T0 + 5 * MIN, stale: false });
    expect(positionAt(track, T0 + 20 * MIN)).toEqual({ lat: 0, lon: 1, ts: T0 + 10 * MIN, stale: false });
    expect(positionAt(track, T0 + 45 * MIN)).toEqual({ lat: 0, lon: 1, ts: T0 + 10 * MIN, stale: true });
    expect(positionAt(track, T0 + 45 * MIN, 60 * MIN)?.lon).toBeCloseTo(1.7, 6);
    expect(positionAt(track, T0 + 120 * MIN)).toEqual({ lat: 0, lon: 2, ts: T0 + 60 * MIN, stale: true });
  });
  it('positionAt bridges a long gap when the phone stayed put', () => {
    const still: TrackPoint[] = [
      { ts: T0, ...north(0) },
      { ts: T0 + 10 * 60 * MIN, ...north(30) }, // 10 h later, 30 m away
    ];
    const p = positionAt(still, T0 + 5 * 60 * MIN);
    expect(p?.stale).toBe(false);
    expect(p?.ts).toBe(T0 + 5 * 60 * MIN);
    expect(haversineM(p!, north(15))).toBeLessThan(1);
  });
  it('trackUpTo grows with t', () => {
    expect(trackUpTo(track, T0 - 1)).toEqual([]);
    expect(trackUpTo(track, T0 + 5 * MIN)).toEqual([track[0], { ts: T0 + 5 * MIN, lat: 0, lon: 0.5 }]);
    expect(trackUpTo(track, T0 + 10 * MIN)).toEqual(track.slice(0, 2));
    expect(trackUpTo(track, T0 + 999 * MIN)).toEqual(track);
  });
  it('togetherSpans finds the overlap where both are close and fresh', () => {
    const a: TrackPoint[] = [];
    const b: TrackPoint[] = [];
    for (let i = 0; i <= 60; i += 5) {
      a.push({ ts: T0 + i * MIN, ...north(0) });
      // b walks away after 30 min: 0 m, then 100 m per 5 min from minute 30.
      b.push({ ts: T0 + i * MIN, ...north(i <= 30 ? 20 : (i - 30) * 20 + 20) });
    }
    const spans = togetherSpans(a, b);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.from).toBe(T0);
    // 150 m reached at minute 36.5 → last 1-min sample inside is minute 36.
    expect(spans[0]!.to).toBe(T0 + 36 * MIN);
    // A gap in b's track across which b moved (> 50 m) breaks the span.
    const gappy = b.filter((p) => p.ts <= T0 + 10 * MIN || p.ts >= T0 + 50 * MIN).map((p) => ({ ...p, ...north(p.ts <= T0 + 10 * MIN ? 0 : 100) }));
    const s2 = togetherSpans(a, gappy);
    expect(s2.map((s) => [(s.from - T0) / MIN, (s.to - T0) / MIN])).toEqual([[0, 10], [50, 60]]);
    // The same gap with b staying put is bridged: one span.
    const still = gappy.map((p) => ({ ...p, ...north(0) }));
    expect(togetherSpans(a, still).map((s) => [(s.from - T0) / MIN, (s.to - T0) / MIN])).toEqual([[0, 60]]);
    expect(togetherSpans([], b)).toEqual([]);
  });
  it('together on latest fixes', () => {
    expect(together({ ...north(0), ts: NOW }, { ...north(100), ts: NOW - 10 * MIN })?.together).toBe(true);
    expect(together({ ...north(0), ts: NOW }, { ...north(100), ts: NOW - 40 * MIN })?.together).toBe(false);
    expect(together({ ...north(0), ts: NOW }, { ...north(4100), ts: NOW })?.distanceM).toBeCloseTo(4100, -1);
    expect(together(null, { ...north(0), ts: NOW })).toBeNull();
  });
});
