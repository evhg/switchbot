// "Pre-cool only if we are at home" (decided 2026-10-29). ac-curve asks presenceGate() before it turns the aircon ON
// for the night; every later command of the night (warming step, OFF, resends) is not gated.
//
// Someone is home when any person's latest presence event (iPhone Shortcuts → `presence` function) is 'home', or the
// night is marked "Home tonight" in the app, and the night is not marked "Away tonight" (or tagged travel). No presence
// data at all → the AC stays off (safe default) with a reason the app shows. Nobody home at the pre-cool start →
// retried on every 5-min tick until lights-out + 3 h; after that the night is skipped. The gate never opens outside
// pre-cool start → lights-out + 3 h, so presence alone can never switch the AC on in the daytime.
// A 'home' signal older than STALE_HOME_H (a lost "Leave" event would otherwise pre-cool every night) is stale: it only
// starts the pre-cool when bedroom CO₂ is also rising in the evening; otherwise the night waits with
// "home signal stale". ac-curve pushes a notification when a presence signal (not "Home tonight") starts the pre-cool.
import type { Ms } from '../../../packages/core/src/types.ts';
import type { Db } from './supabase.ts';

const MIN = 60_000;
/** A late arrival still starts the AC until this long after lights-out. */
export const START_UNTIL_MIN = 180;
/** A 'home' signal older than this no longer starts the pre-cool on its own. */
export const STALE_HOME_H = 48;

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

export function presenceGate(i: GateInput): GateResult {
  if (isAway(i.override, i.tags)) return { allow: false, status: 'away', reason: 'away tonight (marked in the app)' };
  if (i.now < i.precoolStart) return { allow: false, status: 'waiting', reason: 'before pre-cool start' };
  const late = i.now > i.lightsOut + START_UNTIL_MIN * MIN;
  if (i.override === 'home') {
    return late
      ? { allow: false, status: 'skipped', reason: 'too late to start: past lights-out + 3 h' }
      : { allow: true, status: 'override', reason: 'home tonight (set in the app)' };
  }
  const home = i.latest.filter((x) => x.state === 'home');
  const fresh = home.filter((x) => !isStale(x, i.now));
  if (fresh.length) {
    return late
      ? { allow: false, status: 'skipped', reason: `too late to start: past lights-out + 3 h (${names(fresh, i.now)})` }
      : { allow: true, status: 'started', reason: names(fresh, i.now) };
  }
  if (home.length) {
    const who = names(home, i.now);
    if (late) return { allow: false, status: 'skipped', reason: `home signal stale (${who}); nobody confirmed before lights-out + 3 h` };
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

/** Latest presence per person, with names (service-role client). */
export async function loadLatestPresence(db: Db): Promise<LatestPresence[]> {
  const [ev, ppl] = await Promise.all([
    db.from('presence_latest').select('person_id,state,at'),
    db.from('people').select('id,name'),
  ]);
  if (ev.error) throw new Error(`presence_latest: ${ev.error.message}`);
  const nameOf = new Map(((ppl.data ?? []) as { id: string; name: string }[]).map((p) => [p.id, p.name]));
  return ((ev.data ?? []) as { person_id: string; state: PresenceState; at: string }[]).map((r) => ({
    personId: r.person_id,
    name: nameOf.get(r.person_id) ?? r.person_id,
    state: r.state,
    at: Date.parse(r.at),
  }));
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
