// Locations from the OwnTracks app (iOS / Android, HTTP mode), one per person:
//   POST /functions/v1/owntracks
//   Authorization: Basic base64(<user>:<presence token>)   (OwnTracks: Authentication ON, UserID cath / erik,
//                                                            Password = that person's slp_… token from System › Presence)
//   Content-Type: application/json
//   {"_type":"location","lat":7.88,"lon":98.39,"tst":1793606700,"acc":12,"batt":87,"conn":"w","SSID":"…", …}
//   (or an array of messages; X-Presence-Token or "Authorization: Bearer slp_…" also work, for curl tests)
//   {"ping":true}                      → {"ok":true,"person":"a"} (checks the token, stores nothing)
// The person comes from the token (presence_token_person_kinds, migration 0028: a presence token or a phone/device
// device token, never a night-listener one; presence_token_person (0022) before 0028; the user name is ignored). Core
// location/owntracks.ts parses the messages: 'location' fixes and 'transition' (region enter/leave) messages go to
// public.locations (migration 0023; (person_id, ts) is unique, so the phone's retries store nothing twice); waypoints,
// lwt and other types are ignored. Home/away: the newest fresh message of the batch (≤ 60 min old, newer than the
// person's latest presence event) that says something — a home-region transition ("Home"/"thuis"/…) or a fix judged
// against the household's home circle (household_settings.home_*, core homeState() with hysteresis) — is recorded
// with record_presence_for(person, state, 'owntracks'), which stores it only when the state changes (source
// 'shortcut' = a phone signal for ac-curve's gate, via 'owntracks').
// Response: 200 with a JSON array (OwnTracks treats anything else as a failure and queues the message): for every
// OTHER household person with a fix in the last 7 days a {_type:'card'} and their latest {_type:'location'}, so each
// phone shows the other as a friend ([] when the request held only ignored messages). 401 (with WWW-Authenticate:
// Basic) for a bad token, 405 for other methods (GET answers a hint), 413 above 256 KB (Content-Length, and the body
// is read with a byte cap only after the token is checked in the database, so a chunked upload is never buffered
// whole), 500 when storing the fixes failed (the phone keeps them and retries). A failed presence update is logged and
// still answers 200 (the fixes are stored; the next fix tries again).
// JWT verification is off: the presence token is the credential.
import { locationRow, parseOwnTracks, type OwnTracksMessage } from '../../../packages/core/src/location/owntracks.ts';
import { json, serve } from '../_shared/http.ts';
import {
  BASIC_REALM,
  friendsResponse,
  homeFromSettings,
  OWNTRACKS_MAX_BODY,
  owntracksPerson,
  owntracksToken,
  presenceDecision,
  readBodyLimited,
  type FriendRow,
} from '../_shared/owntracks.ts';
import { PRESENCE_TOKEN, type PresenceState } from '../_shared/presence.ts';
import { type Db, serviceClient } from '../_shared/supabase.ts';

const unauthorized = () => json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': `Basic realm="${BASIC_REALM}"` });

serve(async (req) => {
  if (req.method === 'GET') {
    return json({ ok: true, hint: 'OwnTracks HTTP mode: POST location messages with Basic auth (password = your presence token). Setup: System › Location.' });
  }
  if (req.method !== 'POST') return json({ error: 'POST OwnTracks messages' }, 405);
  const len = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(len) && len > OWNTRACKS_MAX_BODY) return json({ error: 'body too large' }, 413);

  // Malformed tokens never reach the database.
  const token = owntracksToken(req.headers);
  if (!token || !PRESENCE_TOKEN.test(token)) return unauthorized();

  // The token is checked before the body is read, so unknown callers never get a body buffered.
  const db = serviceClient();
  const who = await owntracksPerson(db, token);
  if (who.error) {
    console.error('presence_token_person_kinds', who.error);
    return json({ error: 'internal' }, 500);
  }
  const person = who.person;
  if (!person) return unauthorized();

  const text = await readBodyLimited(req, OWNTRACKS_MAX_BODY);
  if (text === null) return json({ error: 'body too large' }, 413);

  let body: unknown = null;
  try {
    body = text.trim() ? JSON.parse(text) : null;
  } catch {
    // Unparseable: nothing a retry would fix, so 200 and an empty array (the phone drops it).
    console.warn('owntracks: body is not JSON');
    return json([]);
  }
  if (body && typeof body === 'object' && !Array.isArray(body) && (body as { ping?: unknown }).ping === true) {
    return json({ ok: true, person });
  }

  const now = Date.now();
  const messages = parseOwnTracks(body, now);
  const invalid = messages.filter((m) => m.kind === 'invalid');
  if (invalid.length) console.warn('owntracks: skipped', JSON.stringify(invalid.slice(0, 5)));
  const rows = messages.flatMap((m) => (m.kind === 'location' || m.kind === 'transition' ? [locationRow(person, m)] : []));

  // Waypoints, lwt, status and unknown types: nothing to store or to retry.
  if (!rows.length) return json([]);
  const res = await db.from('locations').upsert(rows, { onConflict: 'person_id,ts', ignoreDuplicates: true });
  if (res.error) {
    console.error('locations', res.error.message);
    return json({ error: 'internal' }, 500);
  }
  await updatePresence(db, person, messages, now).catch((e) => console.error('owntracks presence', e));

  return json(await friends(db, person, now).catch((e) => {
    console.error('owntracks friends', e);
    return [];
  }));
});

/** Records home/away from the batch when it changes the person's state; returns the new state or null. */
async function updatePresence(db: Db, person: string, messages: readonly OwnTracksMessage[], now: number): Promise<PresenceState | null> {
  if (!messages.some((m) => m.kind === 'location' || m.kind === 'transition')) return null;
  const [settings, latest] = await Promise.all([
    db.from('household_settings').select('home_lat,home_lon,home_radius_m').eq('id', 1).maybeSingle(),
    db.from('presence_latest').select('state,at').eq('person_id', person).maybeSingle(),
  ]);
  if (settings.error) throw new Error(`household_settings: ${settings.error.message}`);
  if (latest.error) throw new Error(`presence_latest: ${latest.error.message}`);
  const prevRow = latest.data as { state: PresenceState; at: string } | null;
  const prev = prevRow ? { state: prevRow.state, at: Date.parse(prevRow.at) } : null;
  const d = presenceDecision(messages, homeFromSettings(settings.data as Parameters<typeof homeFromSettings>[0]), prev, now);
  if (!d || d.state === prev?.state) return null;
  const r = await db.rpc('record_presence_for', { p_person_id: person, p_state: d.state, p_via: 'owntracks' });
  if (r.error) throw new Error(`record_presence_for: ${r.error.message}`);
  const row = (r.data as { state: PresenceState }[] | null)?.[0];
  if (row) console.log(`owntracks presence ${person} → ${row.state} (${d.from})`);
  return row?.state ?? null;
}

/** The other people's cards and latest fixes (fixes from the last 7 days). */
async function friends(db: Db, self: string, now: number): Promise<Record<string, unknown>[]> {
  const ppl = await db.from('people').select('id,name').order('id');
  if (ppl.error) throw new Error(`people: ${ppl.error.message}`);
  const people = (ppl.data ?? []) as { id: string; name: string | null }[];
  const since = new Date(now - 7 * 86_400_000).toISOString();
  const latest: FriendRow[] = [];
  for (const p of people) {
    if (p.id === self) continue;
    const r = await db
      .from('locations')
      .select('person_id,ts,lat,lon,acc_m,batt,conn')
      .eq('person_id', p.id)
      .gte('ts', since)
      .order('ts', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (r.error) throw new Error(`locations: ${r.error.message}`);
    if (r.data) latest.push(r.data as FriendRow);
  }
  return friendsResponse(people, latest, self, now);
}
