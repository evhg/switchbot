import type { Ms, Person, TagKey } from '../types.ts';
import { createRng, mixSeed, type Rng } from './rng.ts';
import { profileFor, type BodyProfile } from './people.ts';
import { addDays, dayNumber, ictMidnight, weekday, MIN } from './time.ts';

// All plan times are minutes from 12:00 ICT on the evening before the wake date (window = 360..1440).
export const DAY_MIN = 1440;
export const WINDOW_START = 360;
const H = (hhmm: number) => {
  // 22.5 → 22:30 → minutes from 12:00 the previous day
  const m = Math.round(hhmm * 60);
  return m >= 12 * 60 ? m - 12 * 60 : m + 12 * 60;
};

export interface Span {
  start: number;
  end: number;
}

export interface PersonPlan {
  index: number;
  person: Person;
  profile: BodyProfile;
  present: boolean;
  sick: boolean;
  /** Nightly sleeping CO2 generation, L/s. */
  co2Lps: number;
  bedIn: number;
  latency: number;
  rise: number;
  inRoom: Span[];
  active: Span[];
  showers: Span[];
  trips: Span[];
}

export interface DoorOpen extends Span {
  /** Extra exchange with house air while open, 1/h. */
  ach: number;
  /** Recorded as a truth event (long enough to see). */
  notable: boolean;
}

export interface NightPlan {
  date: string;
  /** Epoch ms of minute 0 (12:00 ICT the day before `date`). */
  t0: Ms;
  weekend: boolean;
  stayHome: boolean;
  tags: TagKey[];
  lightsOut: number;
  wake: number;
  ach: number;
  cOut: number;
  cHouse: number;
  outMean: number;
  outAmp: number;
  cloud: number;
  /** Bed-height sensor minus AC return-air thermistor, °C. Drifts over days (load, duct, sensor). */
  bedOffset: number;
  /** AC capacity multiplier for the night (filter, refrigerant, load). */
  acCapScale: number;
  doors: DoorOpen[];
  persons: PersonPlan[];
  /** Someone used the wall remote at bedtime (not logged); lasts until the controller's next command. */
  override: { at: number; setpointC: number } | null;
}

export function nightRng(seed: number, date: string, stream: number): Rng {
  return createRng(mixSeed(seed, dayNumber(date), stream));
}

const u = (rng: Rng, a: number, b: number) => a + (b - a) * rng.next();

/** Smooth multi-day drift in about [−1, 1]: a few seeded sinusoids over the day number, so it stays per-date deterministic. */
export function slowDrift(seed: number, date: string, stream: number): number {
  const r = createRng(mixSeed(seed, 77, stream));
  const day = dayNumber(date);
  let v = 0;
  for (const [period, amp] of [[23, 0.5], [9.3, 0.3], [4.1, 0.2]] as const) {
    v += amp * Math.sin((2 * Math.PI * day) / (period * (0.85 + 0.3 * r.next())) + 2 * Math.PI * r.next());
  }
  return v;
}

/** Trips start with p≈1.5 %/night per person and last 2–5 nights; derived from earlier dates so it stays per-date deterministic. */
function travelling(seed: number, date: string, idx: number): boolean {
  for (let k = 0; k < 5; k++) {
    const r = nightRng(seed, addDays(date, -k), 1000 + idx);
    if (r.chance(0.015) && r.int(2, 5) > k) return true;
  }
  return false;
}

function mergeSpans(xs: Span[]): Span[] {
  const s = xs.filter((x) => x.end > x.start).sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const x of s) {
    const last = out[out.length - 1];
    if (last && x.start <= last.end) last.end = Math.max(last.end, x.end);
    else out.push({ ...x });
  }
  return out;
}

export function planNight(seed: number, date: string, people: Person[]): NightPlan {
  const rng = nightRng(seed, date, 1);
  const t0 = ictMidnight(addDays(date, -1)) + 12 * 60 * MIN;
  const wd = weekday(date);
  const weekend = wd === 0 || wd === 6;
  const lateEvening = wd === 6 || wd === 0; // Fri/Sat evenings

  const tags = new Set<TagKey>();
  if (rng.chance(lateEvening ? 0.35 : 0.12)) tags.add('alcohol');
  if (rng.chance(0.15)) tags.add('late_meal');
  if (rng.chance(0.07)) tags.add('late_caffeine');
  if (rng.chance(0.12)) tags.add('late_exercise');
  if (rng.chance(0.05)) tags.add('heavy_duvet');
  if (rng.chance(0.1)) tags.add('door_ajar');

  const away = people.map((_, i) => travelling(seed, date, i));
  if (away.length > 1 && away.every(Boolean)) away[0] = false;
  if (away.some(Boolean)) tags.add('travel');

  const lightsOut = Math.round(Math.min(H(23.75) + (lateEvening ? 20 : 0), Math.max(H(22.5), rng.normal(H(23.08) + (lateEvening ? 15 : 0), 17))));
  const wakeBase = weekend ? rng.normal(H(7.5), 18) : rng.normal(H(7.05), 16);
  const wake = Math.round(Math.min(weekend ? H(8.3) : H(7.75), Math.max(H(6.5), wakeBase)));
  const stayHome = weekend ? rng.chance(0.85) : rng.chance(0.1);
  const leaveHome = Math.round(u(rng, H(8), H(9.5)));
  const eveningInRoom = rng.chance(0.3) ? Math.round(u(rng, H(19.5), H(21))) : null;

  const ach = tags.has('door_ajar') ? u(rng, 0.5, 0.9) : 0.08 + 0.27 * Math.pow(rng.next(), 1.3);
  const order = rng.chance(0.5) ? [0, 1] : [1, 0];
  const together = rng.chance(0.35);
  const persons: PersonPlan[] = [];
  let firstIn = true;
  let firstRise = true;
  for (let pos = 0; pos < people.length; pos++) {
    const i = people.length === 2 ? order[pos]! : pos;
    const person = people[i]!;
    const prng = nightRng(seed, date, 10 + i);
    const profile = profileFor(i);
    const present = !away[i];
    const sick = present && prng.chance(0.025);
    if (sick) tags.add('sick');
    const bedIn = firstIn ? lightsOut : lightsOut + (together ? prng.int(0, 3) : prng.int(5, 40));
    if (present) firstIn = false;
    let latency = profile.latencyMin * Math.exp(prng.normal(0, 0.35));
    if (tags.has('late_caffeine')) latency += u(prng, 8, 20);
    if (sick) latency += 10;
    latency = Math.round(Math.min(45, Math.max(4, latency)));
    const rise = firstRise ? wake : wake + prng.int(0, 30);
    if (present) firstRise = false;
    const inRoom: Span[] = [];
    const active: Span[] = [];
    const showers: Span[] = [];
    const trips: Span[] = [];
    if (present) {
      if (eveningInRoom !== null) inRoom.push({ start: eveningInRoom + prng.int(0, 15), end: bedIn });
      inRoom.push({ start: bedIn - prng.int(5, 25), end: bedIn });
      if (prng.chance(0.75)) {
        const dur = prng.int(9, 16);
        const s = Math.round(u(prng, H(19), bedIn - 25 - dur));
        showers.push({ start: s, end: s + dur });
        inRoom.push({ start: s - 4, end: s + dur + prng.int(6, 14) });
        active.push({ start: s - 2, end: s + dur + 5 });
      }
      inRoom.push({ start: bedIn, end: rise });
      const nTrips = Math.min(3, poisson(prng, 0.45 + (tags.has('alcohol') ? 0.4 : 0) + (sick ? 0.6 : 0)));
      for (let k = 0; k < nTrips; k++) {
        const s = Math.round(u(prng, bedIn + latency + 80, rise - 40));
        if (s + 6 < rise) trips.push({ start: s, end: s + prng.int(3, 6) });
      }
      let leaveRoom: number;
      if (stayHome) {
        leaveRoom = rise + prng.int(30, 75);
        if (prng.chance(0.6)) {
          const s = Math.round(u(prng, H(10), H(11)));
          inRoom.push({ start: s, end: s + prng.int(15, 50) });
        }
      } else {
        leaveRoom = Math.max(rise + 15, leaveHome - prng.int(0, 15));
      }
      inRoom.push({ start: rise, end: leaveRoom });
      active.push({ start: rise, end: rise + 10 });
      if (prng.chance(0.4) && leaveRoom - rise > 25) {
        const s = rise + prng.int(5, leaveRoom - rise - 15);
        const dur = prng.int(7, 12);
        showers.push({ start: s, end: s + dur });
        active.push({ start: s, end: s + dur + 3 });
      }
    }
    const nightly = present ? profile.co2Lps * Math.exp(prng.normal(0, 0.05)) * (sick ? 1.08 : 1) : 0;
    persons.push({
      index: i,
      person,
      profile,
      present,
      sick,
      co2Lps: nightly,
      bedIn,
      latency,
      rise,
      inRoom: mergeSpans(inRoom),
      active: mergeSpans(active),
      showers,
      trips: mergeSpans(trips),
    });
  }
  persons.sort((a, b) => a.index - b.index);

  const doors: DoorOpen[] = [];
  // Brief passages whenever someone enters/leaves (bathroom trips stay inside the open-plan room).
  for (const p of persons) {
    for (const s of p.inRoom) {
      doors.push({ start: s.start, end: s.start + 1, ach: 2.5, notable: false });
      doors.push({ start: s.end, end: s.end + 1, ach: 2.5, notable: false });
    }
  }
  const drng = nightRng(seed, date, 2);
  if (drng.chance(0.15)) {
    const s = Math.round(u(drng, H(19), lightsOut - 30));
    doors.push({ start: s, end: s + drng.int(5, 20), ach: u(drng, 3, 6), notable: true });
  }
  if (drng.chance(0.1)) {
    const s = Math.round(u(drng, lightsOut + 60, wake - 40));
    doors.push({ start: s, end: s + drng.int(3, 10), ach: u(drng, 4, 8), notable: true });
  }
  if (stayHome && drng.chance(0.4)) {
    const s = wake + drng.int(40, 90);
    doors.push({ start: s, end: s + drng.int(20, 60), ach: u(drng, 2, 4), notable: true });
  }

  return {
    date,
    t0,
    weekend,
    stayHome,
    tags: [...tags],
    lightsOut,
    wake,
    ach,
    cOut: Math.round(u(rng, 418, 432)),
    cHouse: Math.round(u(rng, 460, 560)),
    outMean: rng.normal(29.5, 0.5),
    outAmp: u(rng, 2.5, 3.3),
    cloud: u(rng, 0.4, 1),
    bedOffset: Math.min(3, Math.max(-0.8, rng.normal(1, 0.3) + 1.6 * slowDrift(seed, date, 1) + (tags.has('door_ajar') ? 0.3 : 0))),
    acCapScale: Math.min(1.15, Math.max(0.5, 0.92 + 0.3 * slowDrift(seed, date, 2) + nightRng(seed, date, 5).normal(0, 0.06))),
    doors: doors.sort((a, b) => a.start - b.start),
    persons,
    override: drng.chance(0.06) ? { at: lightsOut + drng.int(0, 10), setpointC: drng.int(22, 24) } : null,
  };
}

export function poisson(rng: Rng, lambda: number): number {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  for (;;) {
    p *= rng.next();
    if (p <= L) return k;
    k++;
  }
}
