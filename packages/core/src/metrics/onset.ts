import type { Ms, SleepSession } from '../types.ts';

const MIN = 60_000;
const DAY_MIN = 1440;

/**
 * Typical sleep onset learned from the watches (Fitbit Air via Google Health; sleep_sessions). Pure: the backend uses
 * it to set a new night's expected sleep onset, which anchors the deep window and the warming step of an
 * onset-anchored curve (one-beep-v2).
 *
 * Per person:
 *  - one main sleep per night: the longest session per wake date (ICT) that lasts ≥ minMainMin (3 h) and starts in the
 *    evening/night window 18:00 → 04:00 ICT. Naps (short, or daytime) are ignored;
 *  - its onset is the start of the first non-awake stage (the session start when there are no stages): Fitbit opens a
 *    session a little before you actually drop off;
 *  - only the last `nights` (14) such nights, and at least `minNights` (3) of them, else that person has no value;
 *  - the median of those onsets (robust to the odd late night), on a clock that runs from noon to noon so 23:50 and
 *    00:10 are 20 min apart, not 23 h 40.
 * Household: the LATER of the people's medians. The room has to stay in its cool deep-sleep setting until both are
 * asleep: anchoring to the earlier sleeper would put the second person's first sleep cycles (where most deep sleep
 * happens) closer to the warming step, while being late for the early sleeper only means the warming step comes a
 * little later in their night, which the curve tolerates (21 °C late target either way). It is rounded to 5 min.
 */
export interface SleepOnsetOptions {
  /** Last N main-sleep nights per person. Default 14. */
  nights?: number;
  /** A person needs at least this many main-sleep nights. Default 3. */
  minNights?: number;
  /** Shorter sessions are naps. Default 180 min. */
  minMainMin?: number;
  /** Only sessions ending before this instant count (e.g. tonight's lights-out). Default: all. */
  before?: Ms;
  /** Local offset from UTC, minutes. Default 420 (ICT). */
  utcOffsetMin?: number;
}

export interface PersonOnset {
  personId: string;
  /** Median onset, minute of day (local, 0..1439). */
  minuteOfDay: number;
  /** Nights used. */
  nights: number;
}

export interface TypicalSleepOnset {
  /** Household value, minute of day (local, 0..1439), rounded to 5 min: the later of the people's medians. */
  minuteOfDay: number;
  /** "23:05". */
  hhmm: string;
  /** Person whose median set it (the later sleeper). */
  personId: string;
  perPerson: PersonOnset[];
}

const pad = (n: number) => String(n).padStart(2, '0');
export const minuteToHhmm = (m: number) => {
  const x = ((Math.round(m) % DAY_MIN) + DAY_MIN) % DAY_MIN;
  return `${pad(Math.floor(x / 60))}:${pad(x % 60)}`;
};

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const k = Math.floor(s.length / 2);
  return s.length % 2 ? s[k]! : (s[k - 1]! + s[k]!) / 2;
}

/** Onset of a session: the first stage that is not 'awake', else the session start. */
export function sessionOnset(s: SleepSession): Ms {
  const first = [...s.stages].sort((a, b) => a.start - b.start).find((x) => x.stage !== 'awake' && x.end > x.start);
  return first ? Math.max(s.start, first.start) : s.start;
}

/** Median onset of one person's recent main sleeps, minute of day; null with too few nights. */
export function personSleepOnset(sessions: readonly SleepSession[], opts: SleepOnsetOptions = {}): PersonOnset | null {
  const off = (opts.utcOffsetMin ?? 420) * MIN;
  const minMain = (opts.minMainMin ?? 180) * MIN;
  const byNight = new Map<string, SleepSession>();
  for (const s of sessions) {
    if (!(s.end > s.start) || s.end - s.start < minMain) continue;
    if (opts.before !== undefined && s.end > opts.before) continue;
    const local = new Date(s.start + off);
    const startMod = local.getUTCHours() * 60 + local.getUTCMinutes();
    // Evening/night start only (18:00 → 04:00 local): a long daytime sleep after a night shift is not "bedtime".
    if (startMod < 18 * 60 && startMod >= 4 * 60) continue;
    const wakeDate = new Date(s.end + off).toISOString().slice(0, 10);
    const cur = byNight.get(wakeDate);
    if (!cur || s.end - s.start > cur.end - cur.start) byNight.set(wakeDate, s);
  }
  const recent = [...byNight.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-(opts.nights ?? 14)).map(([, s]) => s);
  if (recent.length < Math.max(1, opts.minNights ?? 3)) return null;
  // Minutes since local noon: 12:00 → 0, 23:00 → 660, 01:00 → 780.
  const sinceNoon = recent.map((s) => {
    const d = new Date(sessionOnset(s) + off);
    return (((d.getUTCHours() * 60 + d.getUTCMinutes() - 720) % DAY_MIN) + DAY_MIN) % DAY_MIN;
  });
  const m = Math.round(median(sinceNoon));
  return { personId: recent[0]!.personId, minuteOfDay: (m + 720) % DAY_MIN, nights: recent.length };
}

/**
 * Household typical sleep onset from each person's sessions (see the module comment). null when nobody has enough
 * main-sleep nights; then the caller keeps the default (lights-out + 60 min = 23:00).
 */
export function typicalSleepOnset(byPerson: Record<string, readonly SleepSession[]> | readonly SleepSession[], opts: SleepOnsetOptions = {}): TypicalSleepOnset | null {
  const groups: Record<string, SleepSession[]> = {};
  if (Array.isArray(byPerson)) {
    for (const s of byPerson as readonly SleepSession[]) (groups[s.personId] ??= []).push(s);
  } else {
    for (const [k, v] of Object.entries(byPerson as Record<string, readonly SleepSession[]>)) groups[k] = [...v];
  }
  const perPerson: PersonOnset[] = [];
  for (const [id, xs] of Object.entries(groups)) {
    const p = personSleepOnset(xs, opts);
    if (p) perPerson.push({ ...p, personId: id });
  }
  if (!perPerson.length) return null;
  const sinceNoon = (m: number) => (m - 720 + DAY_MIN) % DAY_MIN;
  const later = perPerson.reduce((a, b) => (sinceNoon(b.minuteOfDay) > sinceNoon(a.minuteOfDay) ? b : a));
  const rounded = (Math.round(sinceNoon(later.minuteOfDay) / 5) * 5 + 720) % DAY_MIN;
  return { minuteOfDay: rounded, hhmm: minuteToHhmm(rounded), personId: later.personId, perPerson };
}
