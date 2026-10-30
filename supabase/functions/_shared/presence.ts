// "Pre-cool only if we are at home" (decided 2026-10-29), "home by default" (2026-10-30). ac-curve asks presenceGate()
// before it turns the aircon ON for the night; every later command of the night (OFF, resends, an emergency) is not gated.
//
// Order: "Away tonight" (or the travel tag) → away. "Home tonight" → home. An active away period covering tonight's
// evening (public.away_periods, e.g. Bangkok) → away, the AC stays off all night. Then the phones: any person's fresh
// 'home' event → home. With household_settings.default_presence = 'home' (the household's default since 2026-10-30)
// the household is home unless EVERY person's latest phone signal is 'away' and newer than AWAY_FRESH_H (12 h), so no
// presence data at all still pre-cools. With 'unknown' (the 2026-10-29 rule): no presence data → the AC stays off with
// a reason the app shows; a 'home' signal older than STALE_HOME_H only starts the pre-cool together with rising CO₂.
// Nobody home at the pre-cool start → retried on every 5-min tick until lights-out + 3 h; after that the night is
// skipped. The gate never opens outside pre-cool start → lights-out + 3 h, so presence alone can never switch the AC on
// in the daytime. Past lights-out + ASLEEP_START_MIN (15 min, quiet mode's settle) only a late ARRIVAL starts the AC: a
// phone 'home' signal newer than the pre-cool start. The default, "Home tonight" and a stale signal + CO₂ do not, so a
// start that failed at 21:30 (hub offline, retried with backoff) never beeps once they are asleep (2026-10-30). ac-curve pushes a notification when a phone signal (not the default or "Home tonight") starts it.
import type { Ms } from '../../../packages/core/src/types.ts';
import type { Db } from './supabase.ts';

const MIN = 60_000;
/** A late arrival still starts the AC until this long after lights-out. */
export const START_UNTIL_MIN = 180;
/**
 * Without a late arrival (a phone 'home' signal newer than the pre-cool start) the AC is not started later than this
 * after lights-out (= quiet mode's settle window): a start that failed earlier must not beep while they sleep.
 */
export const ASLEEP_START_MIN = 15;
/** A 'home' signal older than this no longer starts the pre-cool on its own. */
export const STALE_HOME_H = 48;
/** default_presence 'home': everyone's latest signal 'away' and newer than this = nobody home tonight. */
export const AWAY_FRESH_H = 12;

/** household_settings.default_presence. */
export type DefaultPresence = 'home' | 'unknown';

/** An active row of public.away_periods: evening dates (YYYY-MM-DD, inclusive) nobody sleeps at home. */
export interface AwayPeriod {
  id?: number;
  from: string;
  to: string;
  note: string | null;
}

export type PresenceState = 'home' | 'away';
export type PrecoolStatus = 'started' | 'override' | 'waiting' | 'skipped' | 'away';

export interface LatestPresence {
  personId: string;
  name: string;
  state: PresenceState;
  at: Ms;
}

export interface GateInput {
  now: Ms;
  /** Pre-cool start (lights-out + the curve's first phase start, ≤ lights-out): the gate is closed before it. */
  precoolStart: Ms;
  lightsOut: Ms;
  override: PresenceState | null;
  tags: readonly string[];
  /** Latest event per person (people without any event are simply absent). */
  latest: readonly LatestPresence[];
  /** Bedroom CO₂ rising in the evening (co2Rising()); only consulted when every 'home' signal is stale. */
  co2Rising?: boolean;
  /** household_settings.default_presence; default 'unknown' (the 2026-10-29 rule). */
  defaultPresence?: DefaultPresence;
  /** Every person of the household (ids): 'everyone away' needs a fresh 'away' from each of them. */
  people?: readonly string[];
  /** The active away period covering tonight's evening, if any (awayPeriodFor). */
  awayPeriod?: AwayPeriod | null;
}

export interface GateResult {
  allow: boolean;
  status: PrecoolStatus;
  reason: string;
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ict = (ms: Ms) => new Date(ms + 7 * 60 * MIN);
/** "18:42" for a time today (ICT) or within the last 12 h, else "Mon 18:42", so an old signal never looks current. */
export function since(at: Ms, now: Ms): string {
  const t = ict(at).toISOString().slice(11, 16);
  const sameDay = ict(at).toISOString().slice(0, 10) === ict(now).toISOString().slice(0, 10);
  return sameDay || (now - at >= 0 && now - at < 12 * 60 * MIN) ? t : `${WD[ict(at).getUTCDay()]} ${t}`;
}
const names = (xs: readonly LatestPresence[], now: Ms) => xs.map((x) => `${x.name} ${x.state} since ${since(x.at, now)}`).join(', ');
export const isStale = (x: LatestPresence, now: Ms) => now - x.at > STALE_HOME_H * 60 * MIN;

/** Night marked away: the AC stays off all night (and an AC assumed on is switched off). */
export function isAway(override: PresenceState | null | undefined, tags: readonly string[] | null | undefined): boolean {
  return override === 'away' || (tags ?? []).includes('travel');
}

/** "Bangkok, 5–6 Nov" style label of an away period. */
export function awayLabel(p: AwayPeriod): string {
  const d = (x: string) => `${Number(x.slice(8, 10))} ${MONTHS[Number(x.slice(5, 7)) - 1]}`;
  const range = p.from === p.to ? `evening of ${d(p.from)}` : `evenings ${d(p.from)}–${d(p.to)}`;
  return p.note ? `${p.note}, ${range}` : range;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The active away period covering the night ending on `nightDate` (its evening is nightDate − 1), or null. */
export function awayPeriodFor(periods: readonly AwayPeriod[], nightDate: string): AwayPeriod | null {
  const evening = new Date(Date.parse(`${nightDate}T00:00:00Z`) - 24 * 60 * MIN).toISOString().slice(0, 10);
  return periods.find((p) => p.from <= evening && evening <= p.to) ?? null;
}

/**
 * Is the whole night off because of the household's plans: "Away tonight" / travel tag, or an away period ("Home
 * tonight" wins over an away period, e.g. a cancelled trip)?
 */
export function nightAway(override: PresenceState | null | undefined, tags: readonly string[] | null | undefined, period: AwayPeriod | null | undefined): string | null {
  if (isAway(override, tags)) return 'away tonight (marked in the app)';
  if (period && override !== 'home') return `away: ${awayLabel(period)}`;
  return null;
}

/** default_presence 'home': every person's latest signal is a fresh 'away' (nobody without a signal). */
export function everyoneAway(latest: readonly LatestPresence[], people: readonly string[] | undefined, now: Ms): boolean {
  const ids = people && people.length ? people : latest.map((x) => x.personId);
  if (!ids.length) return false;
  return ids.every((id) => {
    const x = latest.find((l) => l.personId === id);
    return !!x && x.state === 'away' && now - x.at >= 0 && now - x.at <= AWAY_FRESH_H * 60 * MIN;
  });
}

export function presenceGate(i: GateInput): GateResult {
  const away = nightAway(i.override, i.tags, i.awayPeriod);
  if (away) return { allow: false, status: 'away', reason: away };
  if (i.now < i.precoolStart) return { allow: false, status: 'waiting', reason: 'before pre-cool start' };
  const late = i.now > i.lightsOut + START_UNTIL_MIN * MIN;
  // Past lights-out + settle: they are (about to be) asleep; only someone arriving late may still start the AC.
  const asleep = i.now > i.lightsOut + ASLEEP_START_MIN * MIN;
  const asleepWhy = `too late to start: past lights-out + ${ASLEEP_START_MIN} min without a late arrival (no beep while asleep)`;
  const home = i.latest.filter((x) => x.state === 'home');
  const fresh = home.filter((x) => !isStale(x, i.now));
  const arrived = fresh.filter((x) => x.at >= i.precoolStart && x.at <= i.now);
  if (i.override === 'home' && !(asleep && arrived.length)) {
    return late
      ? { allow: false, status: 'skipped', reason: 'too late to start: past lights-out + 3 h' }
      : asleep
      ? { allow: false, status: 'skipped', reason: asleepWhy }
      : { allow: true, status: 'override', reason: 'home tonight (set in the app)' };
  }
  if (fresh.length) {
    if (late) return { allow: false, status: 'skipped', reason: `too late to start: past lights-out + 3 h (${names(fresh, i.now)})` };
    if (asleep && !arrived.length) return { allow: false, status: 'skipped', reason: `${asleepWhy} (${names(fresh, i.now)})` };
    return { allow: true, status: 'started', reason: names(asleep ? arrived : fresh, i.now) };
  }
  if (i.defaultPresence === 'home') {
    if (everyoneAway(i.latest, i.people, i.now)) {
      const why = `nobody home (${names(i.latest, i.now)}, within ${AWAY_FRESH_H} h)`;
      return late ? { allow: false, status: 'skipped', reason: `${why}; nobody came home before lights-out + 3 h` } : { allow: false, status: 'waiting', reason: why };
    }
    return late
      ? { allow: false, status: 'skipped', reason: 'too late to start: past lights-out + 3 h' }
      : asleep
      ? { allow: false, status: 'skipped', reason: asleepWhy }
      : { allow: true, status: 'override', reason: 'home by default (household setting)' };
  }
  if (home.length) {
    const who = names(home, i.now);
    if (late) return { allow: false, status: 'skipped', reason: `home signal stale (${who}); nobody confirmed before lights-out + 3 h` };
    if (asleep) return { allow: false, status: 'skipped', reason: `${asleepWhy} (home signal stale: ${who})` };
    return i.co2Rising
      ? { allow: true, status: 'started', reason: `${who} (signal older than ${STALE_HOME_H} h) and bedroom CO₂ rising` }
      : { allow: false, status: 'waiting', reason: `home signal stale (${who}): older than ${STALE_HOME_H} h, waiting for a fresh signal, CO₂ rise or "Home tonight"` };
  }
  const why = i.latest.length === 0 ? 'nobody home (no presence signal)' : `nobody home (${names(i.latest, i.now)})`;
  return late
    ? { allow: false, status: 'skipped', reason: `${why}; nobody came home before lights-out + 3 h` }
    : { allow: false, status: 'waiting', reason: why };
}

/**
 * Only the command that turns the AC on for the night is gated: a power-on command while tonight has no power-on
 * command yet (whatever the assumed state says: a stale ON from a failed morning OFF must not skip the gate).
 * Later commands of the night (warming step, emergency, resend) and every OFF pass.
 */
export function needsPresenceGate(cmd: { state: { power: boolean } } | null | undefined, tonight: readonly { state: { power: boolean } }[]): boolean {
  return !!cmd?.state.power && !tonight.some((c) => c.state.power);
}

/** Evening CO₂ rising noticeably over the last hour (same rule as the app's hint in apps/web/lib/tonight.ts). */
export function co2Rising(readings: readonly { ts: Ms; co2: number }[], now: Ms): boolean {
  const last = readings.filter((r) => r.ts > now - 10 * MIN && r.ts <= now && Number.isFinite(r.co2));
  const first = readings.filter((r) => r.ts <= now - 45 * MIN && r.ts > now - 65 * MIN && Number.isFinite(r.co2));
  if (last.length < 3 || first.length < 3) return false;
  const m = (xs: readonly { co2: number }[]) => xs.reduce((a, r) => a + r.co2, 0) / xs.length;
  return m(last) - m(first) >= 120 && m(last) >= 550;
}

/** Household settings (service-role client). A read error or a missing row = the safe defaults: dry run, 'unknown'. */
export async function loadHouseholdSettings(db: Db): Promise<{ acLive: boolean; defaultPresence: DefaultPresence; error: string | null }> {
  const { data, error } = await db.from('household_settings').select('ac_live,default_presence').eq('id', 1).maybeSingle();
  const row = data as { ac_live?: boolean; default_presence?: string } | null;
  return {
    acLive: !error && row?.ac_live === true,
    defaultPresence: !error && row?.default_presence === 'home' ? 'home' : 'unknown',
    error: error ? error.message : row ? null : 'no household_settings row',
  };
}

/** Active away periods that have not ended before `fromDate` (evening dates, YYYY-MM-DD). */
export async function loadAwayPeriods(db: Db, fromDate: string): Promise<AwayPeriod[]> {
  const { data, error } = await db.from('away_periods').select('id,from_date,to_date,note').eq('active', true).gte('to_date', fromDate).order('from_date');
  if (error) throw new Error(`away_periods: ${error.message}`);
  return ((data ?? []) as { id: number; from_date: string; to_date: string; note: string | null }[]).map((r) => ({ id: r.id, from: r.from_date, to: r.to_date, note: r.note }));
}

/** Latest presence per person, with names (service-role client). */
export async function loadLatestPresence(db: Db): Promise<LatestPresence[]> {
  return (await loadPresence(db)).latest;
}

/** Latest presence per person plus every person id of the household. */
export async function loadPresence(db: Db): Promise<{ latest: LatestPresence[]; people: string[] }> {
  const [ev, ppl] = await Promise.all([
    db.from('presence_latest').select('person_id,state,at'),
    db.from('people').select('id,name'),
  ]);
  if (ev.error) throw new Error(`presence_latest: ${ev.error.message}`);
  const nameOf = new Map(((ppl.data ?? []) as { id: string; name: string }[]).map((p) => [p.id, p.name]));
  const latest = ((ev.data ?? []) as { person_id: string; state: PresenceState; at: string }[]).map((r) => ({
    personId: r.person_id,
    name: nameOf.get(r.person_id) ?? r.person_id,
    state: r.state,
    at: Date.parse(r.at),
  }));
  return { latest, people: [...nameOf.keys()] };
}

/** Stores the gate's decision on the night (only when it changed), for the app's "Pre-cool …" line. */
export async function recordGate(
  db: Db,
  night: { date: string; precool_status?: string | null; precool_reason?: string | null },
  g: Pick<GateResult, 'status' | 'reason'>,
  now: Ms,
): Promise<void> {
  if (night.precool_status === g.status && night.precool_reason === g.reason) return;
  const r = await db.from('nights').update({ precool_status: g.status, precool_reason: g.reason, precool_at: new Date(now).toISOString() }).eq('date', night.date);
  if (r.error) console.error('nights precool', r.error.message);
}

// ---------------------------------------------------------------- the `presence` endpoint's request parsing

/** Token format issued by public.rotate_presence_token(): "slp_" + 64 hex digits. */
export const PRESENCE_TOKEN = /^slp_[0-9a-f]{64}$/;

/** X-Presence-Token header, else "Authorization: Bearer slp_…", else a "token" field in the JSON body. */
export function presenceToken(req: Request, body: Record<string, unknown>): string | null {
  const h = req.headers.get('x-presence-token')?.trim();
  if (h) return h;
  const m = req.headers.get('authorization')?.match(/^Bearer\s+(slp_\S+)$/i);
  if (m) return m[1]!.trim();
  return typeof body.token === 'string' ? body.token.trim() : null;
}

export function presenceState(body: Record<string, unknown>): PresenceState | null {
  const s = typeof body.state === 'string' ? body.state.trim().toLowerCase() : '';
  return s === 'home' || s === 'away' ? s : null;
}
