import type { Ms, RoomEvent, RoomReading } from '../types.ts';
import { DEFAULT_OUTDOOR_CO2, fitDecayAch } from './co2.ts';
import { HOUR, MIN, clamp, ictHour, lineSse, median, rollingMedian, theilSen, toMinuteGrid, type MinuteGrid } from './util.ts';

/** One sleeping adult (~0.0031 L/s) in 120 m³ adds ≈ 93 ppm/h; rounded up for awake-ish periods. */
const PERSON_PPM_H = 95;
/** Fastest "normal" ventilation; a drop faster than this decay implies an opened door. */
const DOOR_ACH = 1.0;

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2c = (x: number) => Math.round(x * 100) / 100;

function argMin(xs: readonly number[], lo: number, hi: number): number {
  let best = -1;
  for (let k = Math.max(0, lo); k <= Math.min(xs.length - 1, hi); k++) {
    if (Number.isFinite(xs[k]!) && (best < 0 || xs[k]! < xs[best]!)) best = k;
  }
  return best;
}

function detectShowers(g: MinuteGrid): RoomEvent[] {
  const rh = rollingMedian(g.rh, 1);
  const out: RoomEvent[] = [];
  const n = rh.length;
  for (let i = 1; i < n; i++) {
    if (!Number.isFinite(rh[i]!)) continue;
    const low = argMin(rh, i - 10, i - 1);
    if (low < 0) continue;
    // While the aircon pulls the room down RH falls fast; measure the rise against half that trend.
    const before = rh[Math.max(0, low - 10)]!;
    const fall = Number.isFinite(before) ? Math.max(0, (before - rh[low]!) / Math.min(10, low || 1)) : 0;
    const rise0 = rh[i]! - (rh[low]! - 0.5 * Math.min(fall, 1.5) * (i - low));
    if (rise0 < 9 || rh[i]! - rh[low]! < 6) continue;
    const pre = median(g.rh.slice(Math.max(0, low - 5), low + 1).filter(Number.isFinite));
    // Rise starts at the last minute still at the pre-shower level.
    let start = low;
    for (let k = low; k <= i; k++) if (rh[k]! <= pre + 1) start = k;
    let peak = i;
    let end = -1;
    for (let k = i; k < Math.min(n, i + 240); k++) {
      const v = rh[k]!;
      if (!Number.isFinite(v)) continue;
      if (v <= pre + 3) { end = k; break; }
      // RH often settles above the pre-shower level (humid evening creep); a fresh rise after the
      // decay is the next shower, so end this one at the recent low instead of swallowing it.
      const recent = argMin(rh, Math.max(peak + 5, k - 10), k - 1);
      if (recent >= 0 && v - rh[recent]! >= 4) { end = recent; break; }
      if (v > rh[peak]!) peak = k;
    }
    let tBase = g.temp[low]!;
    let tMax = tBase;
    for (let k = low; k <= Math.min(n - 1, peak + 5); k++) if (g.temp[k]! > tMax) tMax = g.temp[k]!;
    if (!Number.isFinite(tBase)) tBase = tMax;
    const rise = Math.max(rh[peak]! - pre, rise0);
    const tempBump = tMax - tBase >= 0.3;
    const prev = out[out.length - 1];
    const startTs = g.t0 + start * MIN;
    if (prev && (startTs < (prev.end ?? prev.start) || startTs === prev.start)) { i = Math.max(i, end >= 0 ? end : peak + 30); continue; }
    out.push({
      kind: 'shower',
      start: startTs,
      ...(end >= 0 ? { end: g.t0 + end * MIN } : {}),
      confidence: r2c(clamp(0.55 + 0.02 * (rise - 10) + (tempBump ? 0.15 : 0) + (end >= 0 ? 0.1 : 0), 0, 0.97)),
      detail: { preRh: Math.round(pre), peakRh: Math.round(rh[peak]!), riseRh: Math.round(rise), tempBumpC: r1(tMax - tBase) },
    });
    i = end >= 0 ? end : peak + 30;
  }
  return out;
}

function detectDoors(g: MinuteGrid, outdoor: number): RoomEvent[] {
  const c = rollingMedian(g.co2, 1);
  const n = c.length;
  const out: RoomEvent[] = [];
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(c[i]!)) continue;
    let drop = 0;
    let jMax = -1;
    for (let j = i + 1; j <= Math.min(n - 1, i + 10); j++) {
      if (Number.isFinite(c[j]!) && c[i]! - c[j]! > drop) { drop = c[i]! - c[j]!; jMax = j; }
    }
    if (drop < 120 || jMax < 0) continue;
    const expected = Math.max(0, c[i]! - outdoor) * (1 - Math.exp((-DOOR_ACH * (jMax - i)) / 60));
    if (drop < expected) continue;
    // The window can open up to 10 min before the drop; start at the pre-drop maximum.
    let start = i;
    for (let k = i; k <= jMax; k++) if (c[k]! >= c[start]!) start = k;
    let end = jMax;
    while (end + 1 < n && c[end + 1]! < c[end]! - 2) end++;
    const total = c[start]! - c[end]!;
    const ratio = expected > 0 ? drop / expected : 5;
    out.push({
      kind: 'door_open',
      start: g.t0 + start * MIN,
      end: g.t0 + end * MIN,
      confidence: r2c(clamp(0.5 + 0.3 * clamp((drop - 120) / 200, 0, 1) + (ratio > 2 ? 0.15 : 0), 0, 0.95)),
      detail: { dropPpm: Math.round(total), fromPpm: Math.round(c[start]!), toPpm: Math.round(c[end]!) },
    });
    i = end + 10;
  }
  return out;
}

/**
 * Step-change (slope-change) detection: the breakpoint b near `approx` minimising the SSE of a
 * continuous hinge y = a + s1·min(x−b, 0) + s2·max(x−b, 0) over a fixed window.
 */
function refineBreak(c: readonly number[], approx: number, radius = 25, half = 50): number {
  const lo = Math.max(0, approx - half);
  const hi = Math.min(c.length - 1, approx + half);
  let best = approx;
  let bestSse = Infinity;
  for (let b = Math.max(lo + 5, approx - radius); b <= Math.min(hi - 5, approx + radius); b++) {
    // Normal equations for basis [1, u, v], u = min(x−b,0), v = max(x−b,0) (u·v = 0).
    let n = 0, su = 0, sv = 0, suu = 0, svv = 0, sy = 0, suy = 0, svy = 0;
    for (let x = lo; x <= hi; x++) {
      const y = c[x]!;
      if (!Number.isFinite(y)) continue;
      const u = Math.min(x - b, 0);
      const v = Math.max(x - b, 0);
      n++; su += u; sv += v; suu += u * u; svv += v * v; sy += y; suy += u * y; svy += v * y;
    }
    if (n < 10) continue;
    const det = n * (suu * svv) - su * (su * svv) + sv * (0 - suu * sv);
    if (!det) continue;
    const a = (sy * (suu * svv) - su * (suy * svv) + sv * (0 - suu * svy)) / det;
    const s1 = (n * (suy * svv) - sy * (su * svv) + sv * (su * svy - suy * sv)) / det;
    const s2 = (n * (suu * svy) - su * (su * svy - sv * suy) + sy * (0 - suu * sv)) / det;
    let sse = 0;
    for (let x = lo; x <= hi; x++) {
      const y = c[x]!;
      if (Number.isFinite(y)) sse += (y - a - s1 * Math.min(x - b, 0) - s2 * Math.max(x - b, 0)) ** 2;
    }
    if (sse < bestSse) { bestSse = sse; best = b; }
  }
  return best;
}

interface Segment { level: 0 | 1 | 2; lo: number; hi: number }

function occupancyLevels(persons: readonly number[]): Segment[] {
  const lv: (0 | 1 | 2)[] = [];
  let level: 0 | 1 | 2 = 0;
  for (const p of persons) {
    if (Number.isFinite(p)) {
      if (level === 0) level = p >= 1.6 ? 2 : p >= 0.6 ? 1 : 0;
      else if (level === 1) level = p >= 1.6 ? 2 : p < 0.35 ? 0 : 1;
      else level = p < 0.35 ? 0 : p < 1.3 ? 1 : 2;
    }
    lv.push(level);
  }
  // Absorb blips shorter than 15 min into the preceding level.
  let segs: Segment[] = [];
  for (let i = 0; i < lv.length; i++) {
    const last = segs[segs.length - 1];
    if (last && last.level === lv[i]) last.hi = i;
    else segs.push({ level: lv[i]!, lo: i, hi: i });
  }
  let changed = true;
  while (changed && segs.length > 1) {
    changed = false;
    const merged: Segment[] = [];
    for (let k = 0; k < segs.length; k++) {
      const s = segs[k]!;
      const prev = merged[merged.length - 1];
      if (prev && (s.hi - s.lo + 1 < 15 || prev.level === s.level)) { prev.hi = s.hi; changed ||= prev.level !== s.level; }
      else merged.push({ ...s });
    }
    segs = merged;
  }
  return segs;
}

function detectOccupancy(g: MinuteGrid, readings: RoomReading[], doors: RoomEvent[], outdoor: number, lightsOut?: Ms, wake?: Ms): RoomEvent[] {
  const n = g.co2.length;
  if (n < 90) return [];
  const c = g.co2;
  const cs = rollingMedian(c, 2);
  const slope = c.map((_, i) => theilSen(c, Math.max(0, i - 20), Math.min(n - 1, i + 20), 10) * 60);
  // Ventilation estimate for the loss term, from decays outside door openings.
  const doorFree = readings.filter((r) => !doors.some((d) => r.ts >= d.start - 2 * MIN && r.ts <= (d.end ?? d.start) + 15 * MIN));
  const decay = fitDecayAch(doorFree, { outdoorCo2: outdoor });
  const k = decay && decay.ach >= 0.05 && decay.ach <= 1.2 ? decay.ach : 0.15;
  const raw = slope.map((s, i) => (s + k * Math.max(0, cs[i]! - outdoor)) / PERSON_PPM_H);
  for (const d of doors) {
    const lo = Math.round((d.start - g.t0) / MIN) - 20;
    const hi = Math.round(((d.end ?? d.start) - g.t0) / MIN) + 20;
    for (let i = Math.max(0, lo); i <= Math.min(n - 1, hi); i++) raw[i] = NaN;
  }
  const persons = rollingMedian(raw, 3);
  const segs = occupancyLevels(persons);

  // Occupied runs (level ≥ 1) that begin with a genuine rise, not just flat elevated CO₂.
  // Night-time dips ≤ 45 min (an undetected door opening, a short absence) don't split a run.
  const nightTime = (i: number) => (wake !== undefined ? g.t0 + i * MIN < wake : ictHour(g.t0 + i * MIN) >= 18 || ictHour(g.t0 + i * MIN) < 6);
  const runs: { lo: number; hi: number }[] = [];
  for (const s of segs) {
    const last = runs[runs.length - 1];
    if (s.level === 0) continue;
    if (last && s.lo - last.hi <= 45 && nightTime(last.hi)) last.hi = s.hi;
    else runs.push({ lo: s.lo, hi: s.hi });
  }
  const qualifying = runs.filter((r) => {
    if (r.hi - r.lo < 60) return false;
    const early = slope.slice(r.lo, Math.min(r.hi, r.lo + 60) + 1).filter(Number.isFinite);
    return early.length > 0 && Math.max(...early) >= 40;
  });
  if (!qualifying.length) return roomEmpty(g, segs, slope, readings, outdoor, null);
  const lo = lightsOut !== undefined ? Math.round((lightsOut - g.t0) / MIN) : null;
  const run = qualifying.reduce((a, b) => {
    if (lo === null) return b.hi - b.lo > a.hi - a.lo ? b : a;
    const dist = (r: { lo: number; hi: number }) => (lo >= r.lo && lo <= r.hi ? 0 : Math.min(Math.abs(lo - r.lo), Math.abs(lo - r.hi)));
    return dist(b) < dist(a) ? b : a;
  });

  const events: RoomEvent[] = [];
  const entryIdx = refineBreak(c, run.lo);
  // Occupied well before lights-out (evening in the bedroom): CO₂ can't see getting into bed, so anchor
  // on the slope change nearest lights-out at lower confidence.
  const preOccupied = lo !== null && entryIdx < lo - 30 && lo <= run.hi;
  const startIdx = preOccupied ? refineBreak(c, lo, 30, 45) : entryIdx;
  const endIdx = run.hi < n - 30 ? refineBreak(c, run.hi) : run.hi;
  const runPersons = persons.slice(run.lo, run.hi + 1).filter(Number.isFinite);
  const medP = median(runPersons);
  const nearLightsOut = lo !== null ? Math.abs(startIdx - lo) <= 60 : false;
  events.push({
    kind: 'in_bed',
    start: g.t0 + startIdx * MIN,
    end: g.t0 + endIdx * MIN,
    confidence: r2c(clamp(0.5 + 0.2 * clamp(medP, 0, 1) + (nearLightsOut ? 0.2 : 0) - (lo !== null && !nearLightsOut ? 0.15 : 0) - (preOccupied ? 0.25 : 0), 0.1, 0.95)),
    detail: {
      riseRatePpmH: Math.round(median(slope.slice(startIdx + 20, startIdx + 60).filter(Number.isFinite))),
      persons: r1(medP),
      achUsed: Math.round(k * 100) / 100,
      ...(preOccupied ? { roomOccupiedFrom: g.t0 + entryIdx * MIN } : {}),
    },
  });

  const two = segs.find((s) => s.level === 2 && s.lo >= run.lo && s.hi <= run.hi && s.hi - s.lo >= 30 && s.hi > startIdx);
  if (two) {
    const bIdx = Math.max(startIdx, two.lo - run.lo < 30 ? entryIdx : refineBreak(c, two.lo));
    const medTwo = median(persons.slice(two.lo, two.hi + 1).filter(Number.isFinite));
    events.push({
      kind: 'both_in_bed',
      start: g.t0 + bIdx * MIN,
      end: g.t0 + Math.min(two.hi, endIdx) * MIN,
      confidence: r2c(clamp(0.5 + 0.4 * clamp((medTwo - 1.3) / 0.8, 0, 1), 0.1, 0.9)),
      detail: { persons: r1(medTwo) },
    });
  }

  let outIdx: number | null = null;
  if (run.hi < n - 30) {
    const endTs = g.t0 + endIdx * MIN;
    const morning = wake !== undefined ? Math.abs(endTs - wake) <= 3 * HOUR : ictHour(endTs) >= 4 && ictHour(endTs) < 13;
    const after = median(slope.slice(endIdx + 10, endIdx + 40).filter(Number.isFinite));
    if (morning && endIdx - startIdx >= 180 && after < 0) {
      outIdx = endIdx;
      // If people stayed in the room after waking, getting up shows as a slope increase (awake/active
      // breathing) near wake; otherwise out-of-bed is when the slope flips as they leave.
      let upIdx = endIdx;
      let via = 'slope_flip';
      const wi = wake !== undefined ? Math.round((wake - g.t0) / MIN) : null;
      if (wi !== null && endIdx - wi >= 20 && wi - startIdx >= 120) {
        const b = refineBreak(c, wi, 30, 45);
        const before = lineSse(c, b - 30, b).slope;
        const afterUp = lineSse(c, b, Math.min(endIdx, b + 20)).slope;
        if (b < endIdx - 5 && afterUp - before >= 0.3) { upIdx = b; via = 'slope_up'; }
      }
      const upTs = g.t0 + upIdx * MIN;
      events.push({
        kind: 'out_of_bed',
        start: upTs,
        confidence: r2c(clamp(0.5 + 0.3 * clamp(-after / 150, 0, 1) + (wake !== undefined && Math.abs(upTs - wake) <= HOUR ? 0.15 : 0) - (via === 'slope_up' ? 0.1 : 0), 0.1, 0.95)),
        detail: { slopeAfterPpmH: Math.round(after), via, leftRoomAt: endTs },
      });
    }
  }
  return [...events, ...roomEmpty(g, segs, slope, readings, outdoor, outIdx)];
}

function roomEmpty(g: MinuteGrid, segs: Segment[], slope: number[], readings: RoomReading[], outdoor: number, outIdx: number | null): RoomEvent[] {
  const out: RoomEvent[] = [];
  for (const s of segs) {
    if (s.level !== 0) continue;
    const lo = outIdx !== null && outIdx >= s.lo - 30 && outIdx <= s.hi ? outIdx : s.lo;
    const dur = s.hi - lo;
    const startTs = g.t0 + lo * MIN;
    const h = ictHour(startTs);
    if (dur < 60 || h < 5 || h >= 20) continue;
    const sl = median(slope.slice(lo, s.hi + 1).filter(Number.isFinite));
    const excess = (g.co2[lo] ?? NaN) - outdoor;
    if (!(sl < -20 && excess >= 100)) continue;
    const endTs = g.t0 + s.hi * MIN;
    const fit = fitDecayAch(readings.filter((r) => r.ts >= startTs && r.ts <= endTs), { outdoorCo2: outdoor, minMinutes: 45 });
    out.push({
      kind: 'room_empty',
      start: startTs,
      end: endTs,
      confidence: r2c(clamp(0.5 + 0.3 * clamp(dur / 180, 0, 1) + (fit ? 0.15 : 0), 0.1, 0.95)),
      detail: fit ? { ach: Math.round(fit.ach * 100) / 100, r2: Math.round(fit.r2 * 1000) / 1000 } : { slopePpmH: Math.round(sl) },
    });
  }
  return out;
}

/**
 * Room events from 1-min readings: shower (RH +9 in ≤ 10 min, trend-adjusted), door_open (CO₂ drop ≥ 120 ppm in ≤ 10 min,
 * faster than ACH 1 decay), in_bed / both_in_bed / out_of_bed (CO₂ generation regimes from a 40-min
 * Theil–Sen slope plus ventilation loss), room_empty (daytime decay toward baseline).
 */
export function detectEvents(readings: RoomReading[], opts: { lightsOut?: Ms; wake?: Ms } = {}): RoomEvent[] {
  const g = toMinuteGrid(readings);
  if (!g) return [];
  const outdoor = DEFAULT_OUTDOOR_CO2;
  const doors = detectDoors(g, outdoor);
  // Humid outdoor air rushing in through an opened door looks like a shower; a shower never drops CO₂.
  const showers = detectShowers(g).filter((s) => !doors.some((d) => Math.abs(d.start - s.start) <= 5 * MIN));
  const occ = detectOccupancy(g, readings, doors, outdoor, opts.lightsOut, opts.wake);
  return [...showers, ...doors, ...occ].sort((a, b) => a.start - b.start);
}
