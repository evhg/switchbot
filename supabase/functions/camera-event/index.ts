// Camera sightings from the Mac relay (face recognition runs on Erik's Mac, for enrolled, consenting people only):
//   POST /functions/v1/camera-event
//   X-Presence-Token: slp_…            (any household person's presence token; System › Presence)
//   Content-Type: application/json
//   {"camera":"living","events":[{"ts":"2026-11-02T14:05:00+07:00","label":"b","confidence":0.91,"activity":"sofa","durationS":120}]}
//   {"ping":true}                      → {"ok":true,"person":"b"} (checks the token, stores nothing)
// Labels only: 'a' / 'b' (household people), a consenting guest's label, 'unknown' (a face that matched nobody) or
// 'person' (a body, no face). No image, embedding or other biometric data is accepted. Core camera/events.ts validates
// (≤ 100 events, ts within ±1 day, label ≤ 40 chars, confidence 0..1); invalid events are skipped and reported.
// Rows go to public.camera_events (migration 0022); (camera, ts, label) is unique, so a retry stores nothing twice.
// A new 'unknown' sighting (≤ 30 min old) while nobody is home (every person's latest phone signal 'away') pushes
// "Unknown person seen at home (living room, HH:MM)" to every subscription, at most once per 30 min
// (public.claim_camera_alert). JWT verification is off: the presence token is the credential.
import { alertDue, cameraEventRow, parseCameraRequest, unknownAlertText, unknownToAlert, UNKNOWN_ALERT_WINDOW_MIN } from '../../../packages/core/src/camera/events.ts';
import { background, HttpError, json, readJson, serve } from '../_shared/http.ts';
import { loadPresence, nobodyHome, PRESENCE_TOKEN, presenceToken } from '../_shared/presence.ts';
import { appUrl, pushToAll } from '../_shared/push.ts';
import { type Db, serviceClient } from '../_shared/supabase.ts';

serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST {"events":[…]} or {"ping":true}' }, 405);
  const body = await readJson(req);
  const token = presenceToken(req, body)?.toLowerCase() ?? null;
  // Malformed tokens never reach the database.
  if (!token || !PRESENCE_TOKEN.test(token)) throw new HttpError(401, 'unauthorized');

  const db = serviceClient();
  const who = await db.rpc('presence_token_person', { p_token: token });
  if (who.error) {
    console.error('presence_token_person', who.error.message);
    return json({ error: 'internal' }, 500);
  }
  const person = typeof who.data === 'string' ? who.data : null;
  if (!person) throw new HttpError(401, 'unauthorized');

  const now = Date.now();
  const ppl = await db.from('people').select('id');
  const personIds = ppl.error ? ['a', 'b'] : ((ppl.data ?? []) as { id: string }[]).map((p) => p.id);
  const parsed = parseCameraRequest(body, now, personIds);
  if (parsed.kind === 'ping') return json({ ok: true, person });
  if (parsed.kind === 'error') return json({ error: parsed.error }, 400);

  const { events, rejected } = parsed;
  let inserted: { ts: string; camera: string; label: string }[] = [];
  if (events.length) {
    const res = await db
      .from('camera_events')
      .upsert(events.map((e) => cameraEventRow(e)), { onConflict: 'camera,ts,label', ignoreDuplicates: true })
      .select('ts,camera,label');
    if (res.error) {
      console.error('camera_events', res.error.message);
      return json({ error: 'internal' }, 500);
    }
    inserted = (res.data ?? []) as typeof inserted;
  }

  // Only newly stored sightings can alert, so a retried batch never pushes twice.
  const fresh = unknownToAlert(inserted.map((r) => ({ ts: Date.parse(r.ts), camera: r.camera, label: r.label })), now);
  let alert: string | null = null;
  if (fresh) {
    alert = await unknownAlert(db, fresh, now).catch((e) => {
      console.error('unknown alert', e);
      return 'error';
    });
  }

  return json({ ok: true, person, received: events.length + rejected.length, stored: inserted.length, duplicates: events.length - inserted.length, rejected, alert });
});

/** 'sent', or why not: 'someone_home', 'deduped'. */
async function unknownAlert(db: Db, e: { ts: number; camera: string }, now: number): Promise<string> {
  const { latest, people } = await loadPresence(db);
  if (!nobodyHome(latest, people)) return 'someone_home';
  // Cheap check first; the claim below is the atomic one.
  const last = await db.from('camera_alerts').select('last_sent_at').eq('kind', 'unknown').maybeSingle();
  const lastAt = (last.data as { last_sent_at?: string } | null)?.last_sent_at;
  if (!last.error && lastAt && !alertDue(Date.parse(lastAt), now)) return 'deduped';
  const claim = await db.rpc('claim_camera_alert', { p_kind: 'unknown', p_window_min: UNKNOWN_ALERT_WINDOW_MIN, p_event_ts: new Date(e.ts).toISOString() });
  if (claim.error) throw new Error(`claim_camera_alert: ${claim.error.message}`);
  if (claim.data !== true) return 'deduped';
  const send = pushToAll(
    db,
    { title: 'Camera', body: unknownAlertText(e), navigate: `${appUrl()}/settings/camera`, tag: 'camera-unknown' },
    'camera-unknown',
    { urgency: 'high', ttlSec: 30 * 60 },
  ).then((r) => console.log('unknown alert push', JSON.stringify(r)));
  await background(send);
  return 'sent';
}
