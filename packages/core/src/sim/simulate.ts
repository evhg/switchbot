import type { Ms, Night, Person, RoomEvent, RoomReading, TemperatureCurve } from '../types.ts';
import { DEFAULT_CURVE } from '../curve.ts';
import { DEFAULT_REMOTE, type RemoteProfile } from '../control/remote.ts';
import { simulateBody } from './body.ts';
import { DEFAULT_PEOPLE } from './people.ts';
import { DAY_MIN, planNight, WINDOW_START, type NightPlan } from './plan.ts';
import { simulateRoom, type RoomSim } from './room.ts';
import { addDays, ictDate, ictMidnight, MIN } from './time.ts';

export interface SimOptions {
  /** Default 42. */
  seed?: number;
  /** Default 60. */
  nights?: number;
  /** Wake date (YYYY-MM-DD, ICT) of the LAST night; default = today in ICT. */
  endDate?: string;
  people?: Person[];
  /** Default DEFAULT_CURVE. */
  curve?: TemperatureCurve;
  /** Default setAll profile. */
  remote?: RemoteProfile;
  /** Default 120. */
  volumeM3?: number;
}

interface Resolved {
  seed: number;
  people: Person[];
  curve: TemperatureCurve;
  remote: RemoteProfile;
  volume: number;
}

const resolve = (o: SimOptions): Resolved => ({
  seed: o.seed ?? 42,
  people: o.people ?? DEFAULT_PEOPLE,
  curve: o.curve ?? DEFAULT_CURVE,
  remote: o.remote ?? DEFAULT_REMOTE,
  volume: o.volumeM3 ?? 120,
});

/** Zero-occupancy stretches ≥45 min, clipped to the window. */
function emptySpans(plan: NightPlan): { start: number; end: number }[] {
  const occ = new Uint8Array(DAY_MIN);
  for (const p of plan.persons) {
    if (!p.present) continue;
    for (const s of p.inRoom) for (let m = Math.max(0, s.start); m < Math.min(DAY_MIN, s.end); m++) occ[m] = 1;
  }
  const out: { start: number; end: number }[] = [];
  let start = -1;
  for (let m = WINDOW_START; m <= DAY_MIN; m++) {
    const empty = m < DAY_MIN && occ[m] === 0;
    if (empty && start < 0) start = m;
    if (!empty && start >= 0) {
      if (m - start >= 45) out.push({ start, end: m });
      start = -1;
    }
  }
  return out;
}

function truthEvents(plan: NightPlan, room: RoomSim): RoomEvent[] {
  const at = (m: number): Ms => plan.t0 + m * MIN;
  const ev: RoomEvent[] = [];
  const inWin = (m: number) => m >= WINDOW_START && m < DAY_MIN;
  const present = plan.persons.filter((p) => p.present).sort((a, b) => a.bedIn - b.bedIn);
  for (const p of present) {
    for (const s of p.showers) if (inWin(s.start)) ev.push({ kind: 'shower', start: at(s.start), end: at(s.end), confidence: 1, detail: { personId: p.person.id } });
    for (const t of p.trips) ev.push({ kind: 'out_of_bed', start: at(t.start), end: at(t.end), confidence: 1, detail: { personId: p.person.id, reason: 'bathroom' } });
    ev.push({ kind: 'out_of_bed', start: at(p.rise), confidence: 1, detail: { personId: p.person.id, reason: 'rise' } });
  }
  const first = present[0];
  const second = present[1];
  if (first) ev.push({ kind: 'in_bed', start: at(first.bedIn), confidence: 1, detail: { personId: first.person.id } });
  if (second) ev.push({ kind: 'both_in_bed', start: at(second.bedIn), confidence: 1, detail: { personId: second.person.id } });
  for (const d of plan.doors) {
    if (d.notable && inWin(d.start)) ev.push({ kind: 'door_open', start: at(d.start), end: at(d.end), confidence: 1, detail: { minutes: d.end - d.start } });
  }
  for (const s of emptySpans(plan)) ev.push({ kind: 'room_empty', start: at(s.start), end: at(s.end), confidence: 1 });
  for (const c of room.missed) ev.push({ kind: 'ac_missed', start: c.ts, confidence: 1, detail: { setpointC: c.state.setpointC, power: c.state.power ? 'on' : 'off' } });
  return ev.sort((a, b) => a.start - b.start);
}

interface FullNight {
  night: Night;
  /** All 1440 minutes from 12:00 ICT the day before (the stored window starts at 18:00). */
  day: RoomReading[];
}

function simulateFull(date: string, r: Resolved): FullNight {
  const plan = planNight(r.seed, date, r.people);
  // Start from where the previous day ended. That day is run from a cold start: 24 h later the start state
  // has decayed to a few %, so this matches the neighbouring night closely and keeps nights independent of the range.
  const prevPlan = planNight(r.seed, addDays(date, -1), r.people);
  const prev = simulateRoom(prevPlan, r.seed, r.curve, r.remote, r.volume);
  const room = simulateRoom(plan, r.seed, r.curve, r.remote, r.volume, prev.end);
  const people = plan.persons.filter((p) => p.present).map((p) => simulateBody(plan, p, room, r.seed));
  const winStart = plan.t0 + WINDOW_START * MIN;
  const night: Night = {
    date,
    lightsOut: plan.t0 + plan.lightsOut * MIN,
    wake: plan.t0 + plan.wake * MIN,
    room: room.readings.slice(WINDOW_START),
    outdoor: room.outdoor.filter((o) => o.ts >= winStart),
    ac: room.ac,
    curveId: r.curve.id,
    events: [],
    people,
    tags: plan.tags,
    truth: {
      ach: Math.round(plan.ach * 1000) / 1000,
      events: truthEvents(plan, room),
      co2GenLps: Object.fromEntries(plan.persons.filter((p) => p.present).map((p) => [p.person.id, Math.round(p.co2Lps * 1e6) / 1e6])),
    },
  };
  return { night, day: room.readings };
}

/** One night, keyed by its wake date (YYYY-MM-DD ICT). Independent of neighbouring nights, so results never depend on the range requested. */
export function simulateNight(date: string, opts: SimOptions = {}): Night {
  return simulateFull(date, resolve(opts)).night;
}

/** Oldest → newest; 1-min room data 18:00 → 12:00 ICT with truth populated. */
export function simulateNights(opts: SimOptions = {}): Night[] {
  const r = resolve(opts);
  const n = opts.nights ?? 60;
  const end = opts.endDate ?? ictDate(Date.now());
  const out: Night[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(simulateFull(addDays(end, -i), r).night);
  return out;
}

let cache: { key: string; day: RoomReading[] } | null = null;

/**
 * Plausible "current" reading for any instant: the minute of the simulated night that covers `now`
 * (each night's model runs from 12:00 the day before, so every instant is covered).
 */
export function simulateLiveReading(now: Ms, opts: SimOptions = {}): RoomReading {
  const r = resolve(opts);
  const localDate = ictDate(now);
  const noon = ictMidnight(localDate) + 12 * 60 * MIN;
  const date = now >= noon ? addDays(localDate, 1) : localDate;
  const key = [r.seed, date, r.volume, r.curve.id, r.remote.kind, r.people.map((p) => p.id).join(',')].join('|');
  if (!cache || cache.key !== key) cache = { key, day: simulateFull(date, r).day };
  const start = cache.day[0]!.ts;
  const idx = Math.min(DAY_MIN - 1, Math.max(0, Math.floor((now - start) / MIN)));
  return { ...cache.day[idx]! };
}
