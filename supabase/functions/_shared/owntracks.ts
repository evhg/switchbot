// Pure parts of the `owntracks` endpoint (see owntracks/index.ts): credential parsing, the home/away decision for a
// batch of messages, and the friends array the phone gets back. Tested in tests/owntracks.test.ts.
import type { OwnTracksMessage } from '../../../packages/core/src/location/owntracks.ts';
import { homeState, isHomeRegion, type HomePoint } from '../../../packages/core/src/location/geo.ts';
import type { PresenceState } from './presence.ts';

const MIN = 60_000;
const DAY = 86_400_000;

/** Request bodies above this are refused with 413 (a phone flushing a long queue stays well below it). */
export const OWNTRACKS_MAX_BODY = 256 * 1024;
/** Only a fix or transition at most this old may change home/away (a replayed queue from days ago never does). */
export const PRESENCE_MAX_AGE_MS = 60 * MIN;
/** Other people appear on the phone as friends when their latest fix is at most this old. */
export const FRIEND_MAX_AGE_MS = 7 * DAY;
export const BASIC_REALM = 'Jarvis';

/**
 * The request body as text, read in chunks and abandoned (null) as soon as it passes `max` bytes, so a chunked upload
 * without Content-Length is never buffered whole. An absent body is ''.
 */
export async function readBodyLimited(req: Request, max: number = OWNTRACKS_MAX_BODY): Promise<string | null> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/**
 * The presence token: the HTTP Basic password (OwnTracks "Authentication": UserID + Password; the user name is
 * informational and ignored), else X-Presence-Token, else "Authorization: Bearer slp_…" (for curl tests).
 * Trimmed and lower-cased; the caller still checks PRESENCE_TOKEN and the database.
 */
/** Device-token kinds OwnTracks accepts (migration 0028): a night-listener token may not post locations or home/away. */
export const OWNTRACKS_DEVICE_KINDS = ['phone', 'device'] as const;

type RpcResult = { data: unknown; error: { message: string; code?: string } | null };
type RpcCaller = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<RpcResult> };

/** The RPC does not exist yet (PostgREST PGRST202 / Postgres 42883): migration 0028 is not applied. */
export function isMissingRpc(error: { message: string; code?: string } | null): boolean {
  if (!error) return false;
  return error.code === 'PGRST202' || error.code === '42883' || /could not find the function/i.test(error.message);
}

/**
 * The person an OwnTracks token belongs to: a presence token, or a non-revoked device token of kind phone/device
 * (presence_token_person_kinds, 0028). Before 0028 there are no device tokens, so presence_token_person (0022) is
 * the same check. Returns { error } for a database failure, { person: null } for an unknown/refused token.
 */
export async function owntracksPerson(db: RpcCaller, token: string): Promise<{ person: string | null; error?: string }> {
  let res = await db.rpc('presence_token_person_kinds', { p_token: token, p_kinds: [...OWNTRACKS_DEVICE_KINDS] });
  if (isMissingRpc(res.error)) res = await db.rpc('presence_token_person', { p_token: token });
  if (res.error) return { person: null, error: res.error.message };
  return { person: typeof res.data === 'string' && res.data ? res.data : null };
}

export function owntracksToken(headers: Headers): string | null {
  const auth = headers.get('authorization')?.trim() ?? '';
  const basic = auth.match(/^Basic\s+([A-Za-z0-9+/=_-]+)$/i);
  if (basic) {
    let decoded = '';
    try {
      decoded = atob(basic[1]!.replace(/-/g, '+').replace(/_/g, '/'));
    } catch {
      return null;
    }
    const i = decoded.indexOf(':');
    const pw = (i >= 0 ? decoded.slice(i + 1) : '').trim();
    return pw ? pw.toLowerCase() : null;
  }
  const h = headers.get('x-presence-token')?.trim();
  if (h) return h.toLowerCase();
  const bearer = auth.match(/^Bearer\s+(slp_\S+)$/i);
  return bearer ? bearer[1]!.toLowerCase() : null;
}

/** The newest home/away signal in a batch, or null. */
export interface PresenceDecision {
  state: PresenceState;
  at: number;
  from: 'location' | 'transition';
}

/**
 * What the batch says about home/away, from its newest message that says anything: a transition of a home region
 * (enter → home, leave → away; see isHomeRegion) or a location fix judged against the home circle with homeState().
 * Messages older than PRESENCE_MAX_AGE_MS, or not newer than the person's latest presence event (prev.at), are skipped,
 * so a replayed queue or a stale fix never overrides a newer Shortcut signal. Fixes are only judged when home is set.
 */
export function presenceDecision(
  messages: readonly OwnTracksMessage[],
  home: HomePoint | null,
  prev: { state: PresenceState; at: number } | null,
  now: number,
): PresenceDecision | null {
  const candidates: PresenceDecision[] = [];
  for (const m of messages) {
    if (m.kind === 'transition' && isHomeRegion(m.transition.region)) {
      candidates.push({ state: m.transition.event === 'enter' ? 'home' : 'away', at: m.transition.ts, from: 'transition' });
    } else if (m.kind === 'location' && home) {
      const s = homeState(m.fix, home, prev?.state ?? null);
      if (s) candidates.push({ state: s, at: m.fix.ts, from: 'location' });
    }
  }
  const fresh = candidates.filter((c) => now - c.at <= PRESENCE_MAX_AGE_MS && c.at <= now + 5 * MIN && (!prev || c.at > prev.at));
  if (!fresh.length) return null;
  // Newest wins; on a tie a transition (the phone's own geofence) beats a fix.
  fresh.sort((x, y) => y.at - x.at || (x.from === 'transition' ? -1 : 1));
  return fresh[0]!;
}

/** household_settings → the home circle, or null when no home is set. */
export function homeFromSettings(row: { home_lat?: number | null; home_lon?: number | null; home_radius_m?: number | null } | null): HomePoint | null {
  if (!row || typeof row.home_lat !== 'number' || typeof row.home_lon !== 'number') return null;
  return { lat: row.home_lat, lon: row.home_lon, radiusM: row.home_radius_m ?? 150 };
}

const FALLBACK_NAMES: Record<string, string> = { a: 'Cath', b: 'Erik' };

/** Display name for the phone: people.name, unless it is the placeholder 'You' (then Cath / Erik, else the id). */
export function friendName(p: { id: string; name?: string | null }): string {
  const n = p.name?.trim();
  if (n && !/^(you|me)$/i.test(n)) return n;
  return FALLBACK_NAMES[p.id] ?? p.id;
}

/** OwnTracks tracker id: first letter of the name, upper-cased (fallback: the person id upper-cased). */
export function friendTid(p: { id: string; name?: string | null }): string {
  const first = friendName(p).match(/\p{L}|\p{N}/u)?.[0];
  return (first ?? p.id).toUpperCase().slice(0, 2);
}

/** OwnTracks topic for a friend, 'owntracks/<user>/<tid>' as the OwnTracks Recorder sends it (iOS keys friends by topic). */
export function friendTopic(p: { id: string; name?: string | null }): string {
  const user = friendName(p).toLowerCase().replace(/[^a-z0-9_-]+/g, '') || p.id.toLowerCase();
  return `owntracks/${user}/${friendTid(p)}`;
}

export interface FriendRow {
  person_id: string;
  ts: string;
  lat: number;
  lon: number;
  acc_m: number | null;
  batt: number | null;
  conn: string | null;
}

/**
 * The response array: for every OTHER person whose latest fix is at most FRIEND_MAX_AGE_MS old, a card
 * {_type:'card', tid, topic, name} and that fix as {_type:'location', tid, topic, lat, lon, tst (seconds), acc, batt,
 * conn}, so the phone shows them as a friend (Android keys friends by tid, iOS by topic; see friendTopic). Optional fields the row lacks are left out.
 */
export function friendsResponse(
  people: readonly { id: string; name?: string | null }[],
  latest: readonly FriendRow[],
  self: string,
  now: number,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const p of people) {
    if (p.id === self) continue;
    const r = latest.find((l) => l.person_id === p.id);
    const ts = r ? Date.parse(r.ts) : NaN;
    if (!r || !Number.isFinite(ts) || now - ts > FRIEND_MAX_AGE_MS) continue;
    const tid = friendTid(p);
    const topic = friendTopic(p);
    out.push({ _type: 'card', tid, topic, name: friendName(p) });
    const loc: Record<string, unknown> = { _type: 'location', tid, topic, lat: r.lat, lon: r.lon, tst: Math.floor(ts / 1000) };
    if (r.acc_m !== null && r.acc_m !== undefined) loc.acc = r.acc_m;
    if (r.batt !== null && r.batt !== undefined) loc.batt = r.batt;
    if (r.conn) loc.conn = r.conn;
    out.push(loc);
  }
  return out;
}
