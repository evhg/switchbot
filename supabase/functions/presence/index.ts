// Presence from each person's iPhone (Shortcuts personal automations "When I arrive home" / "When I leave home"):
//   POST /functions/v1/presence
//   X-Presence-Token: slp_…            (per person; created/rotated in the app: System › Presence)
//   Content-Type: application/json
//   {"state":"home"}  or  {"state":"away"}
// The token may instead be sent as "Authorization: Bearer slp_…" or as a "token" field in the JSON body.
// Only a SHA-256 hash of each token is stored (private.presence_tokens); public.record_presence() checks it and stores
// the event. JWT verification is off for this function: the token is its credential. ac-curve reads the events
// (_shared/presence.ts) before it pre-cools.
import { HttpError, json, readJson, serve } from '../_shared/http.ts';
import { PRESENCE_TOKEN, presenceState, presenceToken } from '../_shared/presence.ts';
import { serviceClient } from '../_shared/supabase.ts';

serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST {"state":"home"|"away"}' }, 405);
  const body = await readJson(req);
  const token = presenceToken(req, body);
  // Malformed tokens never reach the database.
  if (!token || !PRESENCE_TOKEN.test(token.toLowerCase())) throw new HttpError(401, 'unauthorized');
  const state = presenceState(body);
  if (!state) return json({ error: 'state must be "home" or "away"' }, 400);
  const source = body.source === 'test' ? 'test' : 'shortcut';

  const db = serviceClient();
  const { data, error } = await db.rpc('record_presence', { p_token: token.toLowerCase(), p_state: state, p_source: source });
  if (error) {
    // Details go to the function log only; the caller (a phone Shortcut, or anyone holding the URL) gets a generic error.
    console.error('record_presence', error.message);
    return json({ error: 'internal' }, 500);
  }
  const row = (data as { person_id: string; state: string; at: string }[] | null)?.[0];
  if (!row) throw new HttpError(401, 'unauthorized');
  return json({ ok: true, person: row.person_id, state: row.state, at: row.at });
});
