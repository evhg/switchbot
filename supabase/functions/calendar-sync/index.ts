// Trips in the household's Google Calendars → public.away_periods (source 'calendar', migration 0018).
// For every person of the household: primary-calendar events from 14 days back (the outbound leg of a trip under way;
// further, to the first evening of a stored calendar trip still under way) to 45 days ahead (events.list,
// singleEvents=true, orderBy=startTime; scope calendar.events.readonly, granted with the Google Health consent). Core tripRanges() turns each person's events into away evenings, householdAwayRanges()
// keeps only evenings on which EVERYONE is away (one partner travelling keeps the aircon on for the other), and
// public.sync_calendar_away_periods() upserts them and retires calendar trips that are gone (active = false).
// Manual away periods are never touched. Nothing is written unless every person's calendar was read: a person
// without a connection, or a failed read, could otherwise make the other person's trip look like the household's.
// Nor while tonight is under way (18:00 → noon) if the calendars would newly make tonight an away night.
// Body: {} (pg_cron, hourly) or a household owner/member's JWT ("Sync now"); {"dryRun": true} computes without writing.
import { listCalendarEvents } from '../../../packages/core/src/calendar/client.ts';
import { type AwayRange, householdAwayRanges, tripRanges } from '../../../packages/core/src/calendar/trips.ts';
import { SCOPE_CALENDAR_EVENTS } from '../../../packages/core/src/health/oauth.ts';
import { requireCronOrMember } from '../_shared/auth.ts';
import { googleAccessToken } from '../_shared/google.ts';
import { json, readJson, serve } from '../_shared/http.ts';
import { awayPeriodFor, loadAwayPeriods } from '../_shared/presence.ts';
import { must, serviceClient } from '../_shared/supabase.ts';
import { addDays, DAY, ictAt, nightDateFor, nightWindow, utcDay } from '../_shared/time.ts';

const LOOKBACK_DAYS = 14;
const AHEAD_DAYS = 45;
/** Cap of the extended lookback for a trip under way (away_periods allows 366 days). */
const MAX_LOOKBACK_DAYS = 370;

interface PersonResult {
  personId: string;
  ok: boolean;
  events?: number;
  ranges?: AwayRange[];
  error?: string;
}

serve(async (req) => {
  const db = serviceClient();
  const caller = await requireCronOrMember(req, db);
  const body = await readJson(req);
  const dryRun = body.dryRun === true;
  const now = Date.now();

  // The night that has not started yet (or is under way): its evening and later can change; earlier rows are history.
  const cutoff = addDays(nightDateFor(now), -1);

  const [ppl, tok, underWay] = await Promise.all([
    db.from('people').select('id').order('id'),
    db.from('oauth_tokens').select('person_id,scopes,needs_reconsent'),
    // Calendar trips under way: read from their first evening, or a trip longer than LOOKBACK_DAYS loses its outbound
    // flight, is cut to the night before landing, and its row (keyed by the first evening) gets retired.
    db.from('away_periods').select('from_date').eq('source', 'calendar').eq('in_calendar', true).lt('from_date', cutoff).gte('to_date', cutoff)
      .order('from_date').limit(1),
  ]);
  const people = (must(ppl, 'people') as { id: string }[]).map((p) => p.id);
  const tokens = new Map((must(tok, 'oauth_tokens') as { person_id: string; scopes: string[] | null; needs_reconsent: boolean }[]).map((t) => [t.person_id, t]));

  const firstEvening = (must(underWay, 'away_periods') as { from_date: string }[])[0]?.from_date;
  // A day before that evening (the outbound flight), at most MAX_LOOKBACK_DAYS back.
  const timeMin = Math.max(
    now - MAX_LOOKBACK_DAYS * DAY,
    Math.min(now - LOOKBACK_DAYS * DAY, firstEvening ? ictAt(addDays(firstEvening, -1), '00:00') : Infinity),
  );

  let calls = 0;
  const countingFetch = (i: string, init?: RequestInit) => {
    calls++;
    return fetch(i, init);
  };
  const results: PersonResult[] = [];
  for (const personId of people) {
    const t = tokens.get(personId);
    // Scopes are stored at consent; an empty list (older rows) is simply tried.
    if (!t || t.needs_reconsent || (t.scopes?.length && !t.scopes.includes(SCOPE_CALENDAR_EVENTS))) {
      results.push({ personId, ok: false, error: !t ? 'no Google connection' : t.needs_reconsent ? 'needs reconnecting' : 'calendar not granted; reconnect Google' });
      continue;
    }
    try {
      const { accessToken } = await googleAccessToken(db, personId);
      const events = await listCalendarEvents(accessToken, timeMin, now + AHEAD_DAYS * DAY, { fetch: countingFetch });
      results.push({ personId, ok: true, events: events.length, ranges: tripRanges(events) });
    } catch (e) {
      results.push({ personId, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const ok = people.length > 0 && results.every((r) => r.ok);
  const household = ok ? householdAwayRanges(results.map((r) => r.ranges ?? [])).filter((r) => r.to >= cutoff) : [];
  // Tonight under way (from 18:00 until noon): a trip that would newly cover tonight's evening waits for noon, since an
  // away period switches off an aircon that is already on (ac-curve "ensure off") while they may well be home.
  const nightDate = nightDateFor(now);
  let held: string | null = null;
  if (ok && now >= nightWindow(nightDate).from && household.some((r) => r.from <= cutoff && cutoff <= r.to)) {
    if (!awayPeriodFor(await loadAwayPeriods(db, cutoff), nightDate)) held = `tonight (${cutoff}) newly away in the calendars; not written before noon`;
  }
  let sync: unknown = null;
  if (ok && !dryRun && !held) {
    sync = must(
      await db.rpc('sync_calendar_away_periods', { p_ranges: household.map((r) => ({ from: r.from, to: r.to, note: r.label })), p_cutoff: cutoff }),
      'sync_calendar_away_periods',
    );
  }

  const errors = results.filter((r) => !r.ok).map((r) => `${r.personId}: ${r.error}`).join('; ');
  const log = await db.from('api_quota_log').insert({
    api: 'google_calendar',
    fn: 'calendar-sync',
    calls,
    status: ok && !held ? (dryRun ? 'dry_run' : 'ok') : 'skipped',
    note: (errors || held || `${household.length} household trip(s) from ${cutoff}`).slice(0, 1000),
  });
  if (log.error) console.error('api_quota_log', log.error.message);
  if (calls) {
    const q = await db.rpc('bump_api_quota', { p_api: 'google_calendar', p_day: utcDay(now), p_calls: calls });
    if (q.error) console.error('bump_api_quota', q.error.message);
  }

  return json(
    { ok, dryRun, cutoff, household, people: results, ...(held ? { held } : {}), ...(sync ? { sync } : {}), ...(ok ? {} : { error: `not synced: ${errors || 'no people'}` }) },
    ok || caller === 'cron' ? 200 : 409,
  );
});
