import { describe, expect, it } from 'vitest';
import {
  awayEvenings,
  calendarEventsOf,
  classifyEvent,
  eveningsToRanges,
  flightRoute,
  GoogleCalendarError,
  householdAwayRanges,
  listCalendarEvents,
  placeOutsidePhuket,
  tripRanges,
  type CalendarEvent,
} from '../src/index.ts';

// Fixtures follow the Calendar API v3 Event resource as returned by events.list?singleEvents=true: Gmail-created
// flights carry the departure airport as location and eventType 'fromGmail'.
const timed = (summary: string, start: string, end: string, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  kind: 'calendar#event',
  id: `${summary}-${start}`.replace(/\W/g, '').toLowerCase(),
  status: 'confirmed',
  summary,
  start: { dateTime: start, timeZone: 'Asia/Bangkok' },
  end: { dateTime: end, timeZone: 'Asia/Bangkok' },
  eventType: 'default',
  ...extra,
} as CalendarEvent);
const allDay = (summary: string, start: string, endExclusive: string, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: `${summary}-${start}`.replace(/\W/g, '').toLowerCase(),
  status: 'confirmed',
  summary,
  start: { date: start },
  end: { date: endExclusive },
  transparency: 'transparent',
  eventType: 'default',
  ...extra,
} as CalendarEvent);

const outBkk = timed('Flight to Bangkok (TG 202)', '2026-11-05T10:15:00+07:00', '2026-11-05T11:40:00+07:00', {
  location: 'Phuket HKT',
  eventType: 'fromGmail',
  description: 'Thai Airways TG 202\nConfirmation: 7XKQ2P\nPassenger: Cath',
});
const backHkt = timed('Flight to Phuket (TG 209)', '2026-11-07T16:05:00+07:00', '2026-11-07T17:30:00+07:00', {
  location: 'Bangkok BKK',
  eventType: 'fromGmail',
});

describe('classifyEvent', () => {
  it('reads flight direction from Gmail flights (title + departure airport)', () => {
    expect(flightRoute(outBkk)).toEqual({ from: 'Phuket HKT', to: 'Bangkok' });
    expect(classifyEvent(outBkk)).toMatchObject({ kind: 'out', place: 'Bangkok', strong: true });
    expect(classifyEvent(backHkt)).toMatchObject({ kind: 'in' });
    expect(classifyEvent(timed('HKT → SIN', '2026-12-01T08:00:00+07:00', '2026-12-01T11:00:00+08:00'))).toMatchObject({ kind: 'out', place: 'Singapore' });
    expect(classifyEvent(timed('Flight BKK-CNX', '2026-12-02T08:00:00+07:00', '2026-12-02T09:10:00+07:00'))).toMatchObject({ kind: 'away' });
  });

  it('places: Phuket areas are home, other cities / codes / postcodes are away, virtual is unknown', () => {
    expect(placeOutsidePhuket('Sukhumvit Soi 11, Khlong Toei Nuea, Bangkok 10110, Thailand')).toBe('Bangkok');
    expect(placeOutsidePhuket('89 Moo 3, Ao Nang, Mueang Krabi District, Krabi 81180')).toBe('Krabi');
    expect(placeOutsidePhuket('12 Thanon Rat-U-Thit, Patong, Kathu District, Phuket 83150, Thailand')).toBeNull();
    expect(placeOutsidePhuket('https://meet.google.com/abc-defg-hij')).toBeNull();
    expect(placeOutsidePhuket('99 Moo 1, Tambon Khuek Khak, Takua Pa 82220, Thailand')).toBe('Thailand');
    expect(placeOutsidePhuket('Clinic on the corner')).toBeNull();
  });

  it('ignores cancelled, declined, working-location and check-in reminders; Phuket dinners are home', () => {
    expect(classifyEvent({ ...outBkk, status: 'cancelled' })).toBeNull();
    expect(classifyEvent({ ...outBkk, attendees: [{ self: true, responseStatus: 'declined' }] })).toBeNull();
    expect(classifyEvent(allDay('Office', '2026-11-02', '2026-11-05', { eventType: 'workingLocation' }))).toBeNull();
    expect(classifyEvent(timed('Check in for your flight to Bangkok', '2026-11-04T10:15:00+07:00', '2026-11-04T10:30:00+07:00'))).toBeNull();
    expect(classifyEvent(timed('Dinner', '2026-11-03T19:00:00+07:00', '2026-11-03T21:00:00+07:00', { location: 'Kata Rocks, Kata, Phuket' }))).toMatchObject({ kind: 'home' });
    expect(classifyEvent(timed('Sprint check-in', '2026-11-03T09:00:00+07:00', '2026-11-03T09:30:00+07:00'))).toMatchObject({ kind: 'away', strong: false });
  });

  it('reads events.list pages', () => {
    expect(calendarEventsOf({ kind: 'calendar#events', items: [outBkk, backHkt] })).toHaveLength(2);
    expect(calendarEventsOf([{ items: [outBkk] }, { items: [backHkt] }])).toHaveLength(2);
    expect(calendarEventsOf({ error: { code: 403 } })).toEqual([]);
  });
});

describe('awayEvenings / tripRanges', () => {
  it('pairs out and back flights: evenings between departure and return (Bangkok 5–7 Nov → 5–6)', () => {
    expect(tripRanges([backHkt, outBkk])).toEqual([{ from: '2026-11-05', to: '2026-11-06', label: 'Bangkok' }]);
  });

  it('multi-day all-day event: its last day is the day home', () => {
    expect(tripRanges([allDay('Bangkok', '2026-11-05', '2026-11-08')])).toEqual([{ from: '2026-11-05', to: '2026-11-06', label: 'Bangkok' }]);
    expect(tripRanges([allDay('Long weekend', '2026-11-05', '2026-11-07')])).toEqual([{ from: '2026-11-05', to: '2026-11-05', label: null }]);
    expect(tripRanges([allDay('Bangkok', '2026-11-05', '2026-11-06')])).toEqual([]);
    expect(tripRanges([allDay('Mum visiting', '2026-11-05', '2026-11-12')])).toEqual([]);
  });

  it('hotel stays (Gmail lodging, timed check-in → check-out) are away nights', () => {
    const stay = timed('Stay at Avani+ Riverside Bangkok', '2026-11-20T14:00:00+07:00', '2026-11-22T12:00:00+07:00', {
      location: '257 Charoennakorn Road, Thonburi, Bangkok 10600, Thailand',
      eventType: 'fromGmail',
    });
    expect(tripRanges([stay])).toEqual([{ from: '2026-11-20', to: '2026-11-21', label: 'Bangkok' }]);
  });

  it('a day trip or a late departure is not an away night', () => {
    const dayOut = timed('Flight to Bangkok (FD 3026)', '2026-11-10T07:00:00+07:00', '2026-11-10T08:25:00+07:00', { location: 'Phuket HKT' });
    const dayBack = timed('Flight to Phuket (FD 3035)', '2026-11-10T19:30:00+07:00', '2026-11-10T20:55:00+07:00', { location: 'Bangkok DMK' });
    expect(tripRanges([dayOut, dayBack])).toEqual([]);
    const late = timed('Flight to Singapore (SQ 727)', '2026-11-10T22:30:00+07:00', '2026-11-11T01:45:00+08:00', { location: 'Phuket HKT' });
    const back = timed('Flight to Phuket (SQ 728)', '2026-11-13T09:00:00+08:00', '2026-11-13T10:10:00+07:00', { location: 'Singapore SIN' });
    // Leaves after the 21:30 pre-cool evening → the evening of the 10th stays home; away 11–12.
    expect(tripRanges([late, back])).toEqual([{ from: '2026-11-11', to: '2026-11-12', label: 'Singapore' }]);
  });

  it('a one-way flight alone is no night (could be a guest\'s); with a stay it is', () => {
    expect(tripRanges([outBkk])).toEqual([]);
    expect(tripRanges([backHkt])).toEqual([]);
    const hotel = timed('Hotel: Ibis Riverside', '2026-11-05T15:00:00+07:00', '2026-11-06T12:00:00+07:00', { location: 'Bangkok' });
    expect(tripRanges([outBkk, hotel])).toEqual([{ from: '2026-11-05', to: '2026-11-05', label: 'Bangkok' }]);
  });

  it('flights they meet or see off, and flying lessons, are no departure', () => {
    const pick = timed('Pick up Anna, flight TG201 from Bangkok', '2026-11-05T15:00:00+07:00', '2026-11-05T16:00:00+07:00', { location: 'Phuket International Airport' });
    const lesson = timed('Flight lesson', '2026-11-05T09:00:00+07:00', '2026-11-05T10:00:00+07:00', { location: 'Phuket' });
    expect([pick, lesson].map((e) => classifyEvent(e))).toEqual([null, null]);
  });

  it('events at a place outside Phuket bridge an evening and the next morning', () => {
    const dinner = timed('Dinner with Nok', '2026-11-15T19:00:00+07:00', '2026-11-15T21:00:00+07:00', { location: 'Sorn, 56 Sukhumvit 26, Bangkok 10110' });
    const meeting = timed('Workshop', '2026-11-16T10:00:00+07:00', '2026-11-16T16:00:00+07:00', { location: 'True Digital Park, Bangkok' });
    expect(tripRanges([dinner, meeting])).toEqual([{ from: '2026-11-15', to: '2026-11-15', label: 'Bangkok' }]);
    // Only the dinner: they may fly home late; no night.
    expect(tripRanges([dinner])).toEqual([]);
  });

  it('weak keywords alone never make a night', () => {
    const a = timed('Trip planning', '2026-11-03T19:00:00+07:00', '2026-11-03T20:00:00+07:00');
    const b = timed('Sprint check-in', '2026-11-04T09:00:00+07:00', '2026-11-04T09:30:00+07:00');
    expect(tripRanges([a, b])).toEqual([]);
  });

  it('a Phuket evening event vetoes that evening; separate trips do not merge across a flight home', () => {
    const out = timed('Flight to Bangkok (TG 202)', '2026-11-05T10:15:00+07:00', '2026-11-05T11:40:00+07:00', { location: 'Phuket HKT' });
    const back = timed('Flight to Phuket (TG 209)', '2026-11-09T16:05:00+07:00', '2026-11-09T17:30:00+07:00', { location: 'Bangkok BKK' });
    const home = timed('Dinner at home with Anna', '2026-11-07T19:00:00+07:00', '2026-11-07T22:00:00+07:00', { location: 'Rawai, Phuket' });
    expect(awayEvenings([out, back, home]).map((e) => e.date)).toEqual(['2026-11-05', '2026-11-06', '2026-11-08']);
    const out2 = timed('Flight to Krabi', '2026-11-10T09:00:00+07:00', '2026-11-10T09:40:00+07:00', { location: 'Phuket HKT' });
    const back2 = timed('Flight to Phuket', '2026-11-11T18:00:00+07:00', '2026-11-11T18:40:00+07:00', { location: 'Krabi KBV' });
    expect(tripRanges([out, back, out2, back2])).toEqual([
      { from: '2026-11-05', to: '2026-11-08', label: 'Bangkok' },
      { from: '2026-11-10', to: '2026-11-10', label: 'Krabi' },
    ]);
  });
});

describe('householdAwayRanges', () => {
  it('away only when everyone is away; one partner travelling keeps the aircon on', () => {
    const cath = [{ from: '2026-11-05', to: '2026-11-08', label: 'Bangkok' }];
    const erik = [{ from: '2026-11-06', to: '2026-11-10', label: null }];
    expect(householdAwayRanges([cath, erik])).toEqual([{ from: '2026-11-06', to: '2026-11-08', label: 'Bangkok' }]);
    expect(householdAwayRanges([cath, []])).toEqual([]);
    expect(householdAwayRanges([])).toEqual([]);
    expect(householdAwayRanges([cath])).toEqual(cath);
  });

  it('eveningsToRanges joins consecutive dates and skips duplicates', () => {
    expect(eveningsToRanges([
      { date: '2026-11-02', label: null },
      { date: '2026-11-01', label: 'A' },
      { date: '2026-11-02', label: 'B' },
      { date: '2026-11-04', label: 'C' },
    ])).toEqual([{ from: '2026-11-01', to: '2026-11-02', label: 'A' }, { from: '2026-11-04', to: '2026-11-04', label: 'C' }]);
  });
});

describe('listCalendarEvents', () => {
  it('pages through events.list with singleEvents + orderBy=startTime and a bearer token', async () => {
    const urls: string[] = [];
    const pages = [{ kind: 'calendar#events', items: [outBkk], nextPageToken: 'p2' }, { kind: 'calendar#events', items: [backHkt] }];
    const fake = async (url: string, init?: RequestInit) => {
      urls.push(url);
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
      return new Response(JSON.stringify(pages[urls.length - 1]), { status: 200 });
    };
    const evs = await listCalendarEvents('tok', Date.parse('2026-10-30T00:00:00Z'), Date.parse('2026-12-15T00:00:00Z'), { fetch: fake });
    expect(evs).toHaveLength(2);
    const u = new URL(urls[0]!);
    expect(u.origin + u.pathname).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    expect(u.searchParams.get('singleEvents')).toBe('true');
    expect(u.searchParams.get('orderBy')).toBe('startTime');
    expect(u.searchParams.get('timeMin')).toBe('2026-10-30T00:00:00.000Z');
    expect(new URL(urls[1]!).searchParams.get('pageToken')).toBe('p2');
  });

  it('throws GoogleCalendarError with the status (e.g. 403 without the calendar scope)', async () => {
    const fake = async () => new Response(JSON.stringify({ error: { code: 403, message: 'Request had insufficient authentication scopes.' } }), { status: 403 });
    const err = await listCalendarEvents('tok', 0, 1, { fetch: fake }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleCalendarError);
    expect((err as GoogleCalendarError).status).toBe(403);
  });
});
