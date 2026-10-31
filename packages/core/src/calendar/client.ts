// Google Calendar API v3 events.list for the primary calendar (scope calendar.events.readonly), expanded into single
// instances (singleEvents=true, orderBy=startTime). Only the fields trips.ts reads are requested.
import type { Ms } from '../types.ts';
import type { FetchLike } from '../switchbot/sign.ts';
import { type CalendarEvent, calendarEventsOf } from './trips.ts';

export const GOOGLE_CALENDAR_EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const FIELDS = 'nextPageToken,items(id,status,summary,description,location,start,end,eventType,attendees(self,responseStatus),extendedProperties)';

export class GoogleCalendarError extends Error {
  status: number;
  body?: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'GoogleCalendarError';
    this.status = status;
    if (body !== undefined) this.body = body;
  }
}

export function calendarEventsUrl(timeMin: Ms, timeMax: Ms, pageToken?: string): string {
  const qs = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    timeMin: new Date(timeMin).toISOString(),
    timeMax: new Date(timeMax).toISOString(),
    maxResults: '2500',
    fields: FIELDS,
  });
  if (pageToken) qs.set('pageToken', pageToken);
  return `${GOOGLE_CALENDAR_EVENTS_URL}?${qs}`;
}

/** Every event overlapping [timeMin, timeMax) on the primary calendar (at most `maxPages` pages of 2,500). */
export async function listCalendarEvents(
  accessToken: string,
  timeMin: Ms,
  timeMax: Ms,
  { fetch: f = fetch, maxPages = 5 }: { fetch?: FetchLike; maxPages?: number } = {},
): Promise<CalendarEvent[]> {
  const out: CalendarEvent[] = [];
  let token: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await f(calendarEventsUrl(timeMin, timeMax, token), { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok) {
      const msg = (body as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`;
      throw new GoogleCalendarError(`calendar events.list: ${msg}`, res.status, body);
    }
    out.push(...calendarEventsOf(body));
    token = (body as { nextPageToken?: string } | null)?.nextPageToken;
    if (!token) break;
  }
  return out;
}
