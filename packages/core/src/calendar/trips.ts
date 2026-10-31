// Calendar trips → away nights (decided 2026-10-31). Google Calendar API v3 events (primary calendar,
// singleEvents=true) in, the EVENINGS someone sleeps away from home out: local dates, like public.away_periods
// (the night ending on D is away when D − 1 is one of them).
//
// Signals per event (cancelled and declined events are ignored):
//   flight      'out' (leaves Phuket), 'in' (lands in Phuket) or a flight elsewhere. An 'out' pairs with the next 'in'.
//   stay        a multi-day all-day event, or an overnight timed event with a travel cue (hotel, a place outside
//               Phuket, a Gmail reservation, "trip" …).
//   away point  a timed event at a place outside Phuket, a hotel / Gmail reservation, or a weak keyword (trip, travel,
//               check-in …; weak = it never creates a night on its own).
//   home        a short timed event located in Phuket: vetoes the evening it falls in (dinner in Patong = home).
// Signals within MAX_GAP_H of each other merge into one trip, except across a flight home / from home. An evening E of
// a trip [leave, back] is away when leave ≤ E 20:00 and back ≥ E+1 03:00, so a day trip or a late departure never
// turns the aircon off. Unsure → home: a wrong away night leaves them in a hot room, a wrong home night only costs a
// pre-cool of an empty room.
import type { Ms } from '../types.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export interface CalendarEventTime {
  /** All-day events: "YYYY-MM-DD" (end is exclusive). */
  date?: string;
  /** Timed events: RFC 3339 with offset. */
  dateTime?: string;
  timeZone?: string;
}

/** The fields of a Calendar API v3 Event this module reads. */
export interface CalendarEvent {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: CalendarEventTime;
  end?: CalendarEventTime;
  /** 'default' | 'fromGmail' | 'outOfOffice' | 'focusTime' | 'workingLocation' | 'birthday'. */
  eventType?: string;
  attendees?: { self?: boolean; responseStatus?: string }[];
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> };
}

export type TripSignalKind = 'out' | 'in' | 'stay' | 'away' | 'home';

export interface TripSignal {
  kind: TripSignalKind;
  start: Ms;
  end: Ms;
  /** Weak signals (keywords only) never create an away night on their own. */
  strong: boolean;
  /** Destination / place for the period's note ("Bangkok"), when known. */
  place: string | null;
}

/** Consecutive away evenings (inclusive), as stored in public.away_periods. */
export interface AwayRange {
  from: string;
  to: string;
  label: string | null;
}

export interface TripOptions {
  /** Local offset of the household, minutes east of UTC. Default 420 (ICT, Asia/Bangkok, no DST). */
  utcOffsetMin?: number;
  /** A trip must have started by this local hour of the evening (default 20: the 21:30 pre-cool). */
  leaveByH?: number;
  /** … and last until at least this local hour of the next morning (default 3). */
  backAfterH?: number;
  /** Signals at most this far apart merge into one trip (default 30 h). */
  maxGapH?: number;
}

export const MAX_GAP_H = 30;

// ---------------------------------------------------------------- places

/** Phuket: the island's areas, its airport (HKT) and postcodes 83xxx. */
const PHUKET = /phuket|\bHKT\b|patong|\bkata\b|karon|rawai|chalong|kathu|thalang|cherng ?talay|choeng ?thale|bang ?tao|kamala|surin beach|nai ?harn|mai ?khao|rassada|wichit|ko(?:h)? ?ka(?:ew|eo)|\b83\d{3}\b/i;
const VIRTUAL = /https?:\/\/|zoom|meet\.google|google meet|teams|webex|online|virtual|\bcall\b|phone/i;

/**
 * [label, name pattern, airport codes]: places outside Phuket that show up in their calendars (cities, islands,
 * countries). Codes match uppercase only, so "got" or "pen" in a title is no airport.
 */
const PLACES: readonly (readonly [string, RegExp, readonly string[]])[] = [
  ['Bangkok', /bangkok|krung ?thep|suvarnabhumi|don m[uư]eang/i, ['BKK', 'DMK']],
  ['Krabi', /krabi|ao nang|railay/i, ['KBV']],
  ['Khao Lak', /khao ?lak/i, []],
  ['Phang Nga', /phang ?nga/i, []],
  ['Phi Phi', /phi ?phi/i, []],
  ['Koh Lanta', /\blanta\b/i, []],
  ['Koh Samui', /samui/i, ['USM']],
  ['Koh Phangan', /phangan/i, []],
  ['Koh Tao', /\bkoh? tao\b/i, []],
  ['Chiang Mai', /chiang ?mai/i, ['CNX']],
  ['Chiang Rai', /chiang ?rai/i, ['CEI']],
  ['Hua Hin', /hua ?hin/i, ['HHQ']],
  ['Pattaya', /pattaya/i, ['UTP']],
  ['Hat Yai', /hat ?yai/i, ['HDY']],
  ['Surat Thani', /surat ?thani/i, ['URT']],
  ['Ranong', /ranong/i, []],
  ['Singapore', /singapore/i, ['SIN']],
  ['Kuala Lumpur', /kuala lumpur/i, ['KUL']],
  ['Penang', /penang/i, ['PEN']],
  ['Langkawi', /langkawi/i, ['LGK']],
  ['Bali', /\bbali\b|denpasar/i, ['DPS']],
  ['Jakarta', /jakarta/i, ['CGK']],
  ['Hong Kong', /hong ?kong/i, ['HKG']],
  ['Tokyo', /tokyo/i, ['NRT', 'HND']],
  ['Osaka', /osaka/i, ['KIX']],
  ['Seoul', /seoul/i, ['ICN']],
  ['Taipei', /taipei/i, ['TPE']],
  ['Hanoi', /hanoi/i, ['HAN']],
  ['Ho Chi Minh City', /ho chi minh|saigon/i, ['SGN']],
  ['Siem Reap', /siem ?reap/i, []],
  ['Manila', /manila/i, ['MNL']],
  ['Dubai', /dubai/i, ['DXB']],
  ['Doha', /\bdoha\b/i, ['DOH']],
  ['Istanbul', /istanbul/i, ['IST']],
  ['London', /london/i, ['LHR', 'LGW']],
  ['Paris', /\bparis\b/i, ['CDG']],
  ['Amsterdam', /amsterdam/i, ['AMS']],
  ['Frankfurt', /frankfurt/i, ['FRA']],
  ['Munich', /munich|münchen/i, ['MUC']],
  ['Zurich', /zurich|zürich/i, ['ZRH']],
  ['Stockholm', /stockholm/i, ['ARN']],
  ['Gothenburg', /gothenburg|göteborg/i, ['GOT']],
  ['Copenhagen', /copenhagen|københavn/i, ['CPH']],
  ['Oslo', /\boslo\b/i, ['OSL']],
  ['Helsinki', /helsinki/i, ['HEL']],
  ['Sydney', /sydney/i, ['SYD']],
  ['Melbourne', /melbourne/i, ['MEL']],
  ['New York', /new york/i, ['JFK', 'EWR']],
  ['San Francisco', /san francisco/i, ['SFO']],
  ['Los Angeles', /los angeles/i, ['LAX']],
  ['Sweden', /sweden|sverige/i, []],
  ['Norway', /norway|norge/i, []],
  ['Denmark', /denmark|danmark/i, []],
  ['Germany', /germany|deutschland/i, []],
  ['United Kingdom', /united kingdom|\bengland\b|\bscotland\b/i, []],
  ['United States', /united states|\bUSA\b/i, []],
  ['Malaysia', /malaysia/i, []],
  ['Indonesia', /indonesia/i, []],
  ['Vietnam', /vietnam|viet nam/i, []],
  ['Cambodia', /cambodia/i, []],
  ['Japan', /japan/i, []],
  ['Australia', /australia/i, []],
];
/** Airport codes as written in flight titles ("HKT → BKK"): uppercase, case-sensitive. */
const IATA = /\b([A-Z]{3})\b/g;
/** A Thai address with a postcode outside Phuket (83xxx). */
const THAI_POSTCODE = /\b(\d{5})\b[^\n]*thailand|thailand[^\n]*\b(\d{5})\b/i;

const hasCode = (text: string, code: string) => new RegExp(`\\b${code}\\b`).test(text);
const KNOWN_CODES = new Set(['HKT', ...PLACES.flatMap(([, , codes]) => codes)]);

/** Text names Phuket (an area, HKT or a 83xxx postcode). */
export function inPhuket(text: string | null | undefined): boolean {
  return !!text && PHUKET.test(text);
}

/** The place a location text names outside Phuket ("Bangkok"), or null (Phuket, virtual, or unknown). */
export function placeOutsidePhuket(text: string | null | undefined): string | null {
  if (!text || inPhuket(text) || VIRTUAL.test(text)) return null;
  for (const [label, re, codes] of PLACES) if (re.test(text) || codes.some((c) => hasCode(text, c))) return label;
  const pc = text.match(THAI_POSTCODE);
  const code = pc?.[1] ?? pc?.[2];
  if (code && !code.startsWith('83')) return 'Thailand';
  return null;
}

// ---------------------------------------------------------------- cues

const FLIGHT = /\bflights?\b|\bflyg\b/i;
/** Flight-like events that are not their own departure: someone else's flight they meet / see off, flying lessons. */
const NOT_OWN_FLIGHT = /\b(?:pick(?:ing)?[- ]?up|drop(?:ping)?[- ]?off|see (?:\w+ )?off|meet(?:ing)?|collect|school|lessons?|class|simulator)\b/i;
const LODGING = /\b(?:hotel|resort|hostel|airbnb|agoda|booking\.com|guest ?house|stay(?:ing)? at|accommodation|lodging)\b/i;
const WEAK = /\b(?:trip|travel(?:l?ing)?|vacation|holiday|check[- ]?in|check[- ]?out|airport|boarding|layover|ferry|departure|arrival)\b/i;
/** Multi-day all-day events that mean someone is (also) at home: guests, working from home. */
const AT_HOME = /\b(?:visit(?:s|ing|ors?)?|guests?|staying with us|at home|wfh|work(?:ing)? from home)\b/i;
const IGNORED_TYPES = new Set(['workingLocation', 'focusTime', 'birthday']);

/** Gmail-created reservations: eventType 'fromGmail', or Gmail / reservation keys in extendedProperties. */
export function isFromGmail(e: CalendarEvent): boolean {
  if (e.eventType === 'fromGmail') return true;
  const keys = [...Object.keys(e.extendedProperties?.private ?? {}), ...Object.keys(e.extendedProperties?.shared ?? {})];
  return keys.some((k) => /gmail|reservation|flight|lodging|hotel/i.test(k));
}

/** Known airport codes in a title, in order ("HKT → BKK" → ['HKT', 'BKK']). */
const airportCodes = (text: string) => [...text.matchAll(IATA)].map((m) => m[1]!).filter((c) => KNOWN_CODES.has(c));

/** Origin and destination of a flight event: "HKT → BKK", "Flight to Bangkok (TG 202)" + location "Phuket HKT". */
export function flightRoute(e: CalendarEvent): { from: string | null; to: string | null } {
  const summary = e.summary ?? '';
  const codes = airportCodes(summary);
  if (codes.length >= 2) return { from: codes[0]!, to: codes[1]! };
  const fromTo = summary.match(/\bfrom\s+(.+?)\s+(?:to|→|->)\s+(.+?)(?:\s*[(,]|$)/i);
  if (fromTo) return { from: fromTo[1]!.trim(), to: fromTo[2]!.trim() };
  const to = summary.match(/(?:\bto|→|->)\s+(.+?)(?:\s*[(,]|\s+on\s|$)/i);
  // Gmail flight events carry the departure airport as their location.
  return { from: e.location?.trim() || null, to: to ? to[1]!.trim() : codes[0] ?? null };
}

// ---------------------------------------------------------------- time

const localDate = (ms: Ms, off: number) => new Date(ms + off * MIN).toISOString().slice(0, 10);
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
/** Epoch ms of local `h`:00 on `date`. */
const localAt = (date: string, h: number, off: number) => Date.parse(`${date}T00:00:00Z`) - off * MIN + h * HOUR;

/** Start / end of an event; all-day events from local midnight to local midnight of the (exclusive) end date. */
export function eventSpan(e: CalendarEvent, utcOffsetMin = 420): { start: Ms; end: Ms; allDay: boolean; days: number } | null {
  const sd = e.start?.date;
  const ed = e.end?.date;
  if (sd && /^\d{4}-\d{2}-\d{2}$/.test(sd)) {
    const end = ed && /^\d{4}-\d{2}-\d{2}$/.test(ed) && ed > sd ? ed : addDays(sd, 1);
    const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${sd}T00:00:00Z`)) / DAY);
    return { start: localAt(sd, 0, utcOffsetMin), end: localAt(end, 0, utcOffsetMin), allDay: true, days };
  }
  const start = e.start?.dateTime ? Date.parse(e.start.dateTime) : NaN;
  const end0 = e.end?.dateTime ? Date.parse(e.end.dateTime) : NaN;
  if (!Number.isFinite(start)) return null;
  const end = Number.isFinite(end0) && end0 >= start ? end0 : start + HOUR;
  return { start, end, allDay: false, days: 0 };
}

const declined = (e: CalendarEvent) => (e.attendees ?? []).some((a) => a.self && a.responseStatus === 'declined');

/** The trip signal of one event, or null (not travel, not at home, or not a real event). */
export function classifyEvent(e: CalendarEvent, opts: TripOptions = {}): TripSignal | null {
  const off = opts.utcOffsetMin ?? 420;
  if (e.status === 'cancelled' || declined(e) || IGNORED_TYPES.has(e.eventType ?? '')) return null;
  const span = eventSpan(e, off);
  if (!span) return null;
  const summary = e.summary ?? '';
  const loc = e.location ?? '';
  const desc = (e.description ?? '').slice(0, 2000);
  const gmail = isFromGmail(e);
  const lodging = LODGING.test(summary) || (gmail && LODGING.test(desc));

  // "Check in for your flight to Bangkok" (a day ahead) is a reminder, not the departure.
  if (/^\s*(?:online )?check[- ]?in\b.*\bflight/i.test(summary)) return null;
  if (FLIGHT.test(summary) || airportCodes(summary).length >= 2) {
    if (NOT_OWN_FLIGHT.test(summary)) return null;
    const r = flightRoute(e);
    const place = r.to && !inPhuket(r.to) ? placeOutsidePhuket(r.to) ?? r.to.replace(/\s*\(.*$/, '').slice(0, 40) : null;
    const kind: TripSignalKind = inPhuket(r.to) ? 'in' : inPhuket(r.from) || (!r.from && !!r.to) ? 'out' : 'away';
    return { kind, start: span.start, end: span.end, strong: true, place };
  }

  const place = placeOutsidePhuket(loc);
  const phuket = inPhuket(loc || summary);
  if (span.allDay) {
    // Multi-day all-day event = the days of a trip, the last one being the day home ("Bangkok 5–7 Nov": evenings 5–6).
    if (span.days < 2 || (phuket && !lodging) || AT_HOME.test(summary)) return null;
    return { kind: 'stay', start: span.start, end: localAt(addDays(localDate(span.end, off), -1), 12, off), strong: true, place: place ?? placeOutsidePhuket(summary) };
  }
  const overnight = localDate(span.end - 1, off) > localDate(span.start, off);
  if (overnight && (lodging || (gmail && !phuket) || place || (!phuket && WEAK.test(summary)))) {
    return { kind: 'stay', start: span.start, end: span.end, strong: true, place: place ?? placeOutsidePhuket(summary) };
  }
  if (phuket && !lodging) return span.end - span.start <= 12 * HOUR ? { kind: 'home', start: span.start, end: span.end, strong: true, place: null } : null;
  if (place) return { kind: 'away', start: span.start, end: span.end, strong: true, place };
  if (lodging) return { kind: 'away', start: span.start, end: span.end, strong: true, place: placeOutsidePhuket(summary) };
  if (WEAK.test(summary) || WEAK.test(desc)) return { kind: 'away', start: span.start, end: span.end, strong: gmail, place: null };
  return null;
}

/** Events of a Calendar API `events.list` page (or several pages, or a bare array). */
export function calendarEventsOf(json: unknown): CalendarEvent[] {
  const pages = Array.isArray(json) ? json : [json];
  const out: CalendarEvent[] = [];
  for (const p of pages) {
    const items = typeof p === 'object' && p !== null && 'items' in p ? (p as { items?: unknown }).items : p;
    if (Array.isArray(items)) {
      for (const x of items) if (typeof x === 'object' && x !== null && !Array.isArray(x)) out.push(x as CalendarEvent);
    } else if (typeof items === 'object' && items !== null && ('start' in items || 'summary' in items)) {
      out.push(items as CalendarEvent);
    }
  }
  return out;
}

interface Trip {
  start: Ms;
  end: Ms;
  /** Starts with a flight from home / ends with a flight home: nothing merges across that edge. */
  fromHome: boolean;
  toHome: boolean;
  strong: boolean;
  place: string | null;
}

/** Away evenings of one person, sorted, each with the trip's place (or null). */
export function awayEvenings(events: readonly CalendarEvent[], opts: TripOptions = {}): { date: string; label: string | null }[] {
  const off = opts.utcOffsetMin ?? 420;
  const leaveBy = opts.leaveByH ?? 20;
  const backAfter = opts.backAfterH ?? 3;
  const maxGap = (opts.maxGapH ?? MAX_GAP_H) * HOUR;
  const signals = events.map((e) => classifyEvent(e, opts)).filter((s): s is TripSignal => s !== null);
  const homes = signals.filter((s) => s.kind === 'home');
  const travel = signals.filter((s) => s.kind !== 'home').sort((a, b) => a.start - b.start);

  // Flights: each 'out' pairs with the next 'in'. Unpaired: one night after leaving / before landing, but weak (a guest's
  // flight shared into both calendars looks the same): it only counts merged with a stay or another strong signal.
  const trips: Trip[] = [];
  let open: TripSignal | null = null;
  const point = (s: TripSignal): Trip => ({ start: s.start, end: s.end, fromHome: false, toHome: false, strong: s.strong, place: s.place });
  for (const s of travel) {
    if (s.kind === 'out') {
      if (open) trips.push(point(s));
      else open = s;
    } else if (s.kind === 'in') {
      if (open) trips.push({ start: open.start, end: s.end, fromHome: true, toHome: true, strong: true, place: open.place });
      else trips.push({ start: Math.min(s.start, localAt(addDays(localDate(s.start, off), -1), 12, off)), end: s.end, fromHome: false, toHome: true, strong: false, place: null });
      open = null;
    } else trips.push(point(s));
  }
  if (open) trips.push({ start: open.start, end: Math.max(open.end, localAt(addDays(localDate(open.start, off), 1), 12, off)), fromHome: true, toHome: false, strong: false, place: open.place });

  trips.sort((a, b) => a.start - b.start);
  const merged: Trip[] = [];
  for (const t of trips) {
    const last = merged[merged.length - 1];
    if (last && (t.start <= last.end || (t.start - last.end <= maxGap && !last.toHome && !t.fromHome))) {
      if (t.end > last.end) {
        last.end = t.end;
        last.toHome = t.toHome;
      }
      last.strong ||= t.strong;
      last.place ??= t.place;
    } else merged.push({ ...t });
  }

  const vetoed = (d: string) => homes.some((h) => h.start < localAt(addDays(d, 1), 7, off) && h.end > localAt(d, 19, off));
  const out = new Map<string, string | null>();
  for (const t of merged) {
    if (!t.strong) continue;
    for (let d = localDate(t.start, off); d <= localDate(t.end, off); d = addDays(d, 1)) {
      if (t.start <= localAt(d, leaveBy, off) && t.end >= localAt(addDays(d, 1), backAfter, off) && !vetoed(d) && !out.has(d)) out.set(d, t.place);
    }
  }
  return [...out.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, label]) => ({ date, label }));
}

/** Sorted evenings → ranges of consecutive dates; a range takes the label of its first labelled evening. */
export function eveningsToRanges(evenings: readonly { date: string; label: string | null }[]): AwayRange[] {
  const out: AwayRange[] = [];
  for (const e of [...evenings].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    const last = out[out.length - 1];
    if (last && addDays(last.to, 1) === e.date) {
      last.to = e.date;
      last.label ??= e.label;
    } else if (!last || e.date > last.to) out.push({ from: e.date, to: e.date, label: e.label });
  }
  return out;
}

/** A person's trips as away ranges. */
export function tripRanges(events: readonly CalendarEvent[], opts: TripOptions = {}): AwayRange[] {
  return eveningsToRanges(awayEvenings(events, opts));
}

/**
 * Household rule: an evening is away only when EVERY person (with a calendar connection) is away that evening; one
 * partner travelling keeps the aircon on for the other. No people → no away evenings.
 */
export function householdAwayRanges(perPerson: readonly (readonly AwayRange[])[]): AwayRange[] {
  if (!perPerson.length) return [];
  const expand = (rs: readonly AwayRange[]) => {
    const m = new Map<string, string | null>();
    for (const r of rs) for (let d = r.from; d <= r.to; d = addDays(d, 1)) if (!m.has(d)) m.set(d, r.label);
    return m;
  };
  const [first, ...rest] = perPerson.map(expand);
  const both = [...first!.entries()]
    .filter(([d]) => rest.every((m) => m.has(d)))
    .map(([date, label]) => ({ date, label: label ?? rest.map((m) => m.get(date) ?? null).find((x) => x !== null) ?? null }));
  return eveningsToRanges(both);
}
