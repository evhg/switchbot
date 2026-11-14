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
// Door clips (migration 0041, the Mac's brief face/JARVIS-door-clips.md): an unknown event with "wantClip": true and
// "people": [{"faces": [...]}] gets "uploads" (signed upload URLs for its MP4 clip and one JPEG per person) in the
// answer; GET ?names=1 serves names chosen in the app ({names: [{id, faces, label}]}), POST {"namesApplied": [ids]}
// marks them applied. Clips are deleted once everyone in the pass is named or forgotten, or after 14 days.
import { alertDue, cameraEventRow, parseCameraRequest, unknownAlertText, unknownToAlert, UNKNOWN_ALERT_WINDOW_MIN } from '../../../packages/core/src/camera/events.ts';
import { background, HttpError, json, readJson, serve } from '../_shared/http.ts';
import { loadPresence, nobodyHome, PRESENCE_TOKEN, presenceToken } from '../_shared/presence.ts';
import { appUrl, pushToAll } from '../_shared/push.ts';
import { type Db, serviceClient } from '../_shared/supabase.ts';

serve(async (req) => {
  if (req.method !== 'POST' && req.method !== 'GET') return json({ error: 'POST {"events":[…]} or {"ping":true}; GET ?names=1' }, 405);
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
  // Door clips (migration 0041): names chosen in the app go back to the Mac.
  if (req.method === 'GET') {
    if (new URL(req.url).searchParams.get('names') !== '1') return json({ error: 'GET ?names=1' }, 400);
    await pruneDoorClips(db, now).catch((e) => console.error('door clip retention', e instanceof Error ? e.message : String(e)));
    const { data, error } = await db.from('face_names').select('id,faces,label').is('applied_at', null).order('id').limit(100);
    if (error) return json({ error: 'internal' }, 500);
    return json({ names: data ?? [] });
  }
  if (Array.isArray(body.namesApplied)) {
    const ids = body.namesApplied.filter((x): x is number => Number.isInteger(x)).slice(0, 200);
    if (ids.length) await db.from('face_names').update({ applied_at: new Date(now).toISOString() }).in('id', ids).is('applied_at', null);
    return json({ ok: true, applied: ids.length });
  }
  const ppl = await db.from('people').select('id');
  const personIds = ppl.error ? ['a', 'b'] : ((ppl.data ?? []) as { id: string }[]).map((p) => p.id);
  const parsed = parseCameraRequest(body, now, personIds);
  if (parsed.kind === 'ping') return json({ ok: true, person });
  if (parsed.kind === 'error') return json({ error: parsed.error }, 400);

  const { events, rejected } = parsed;
  let inserted: { id: number; ts: string; camera: string; label: string }[] = [];
  if (events.length) {
    const res = await db
      .from('camera_events')
      .upsert(events.map((e) => cameraEventRow(e)), { onConflict: 'camera,ts,label', ignoreDuplicates: true })
      .select('id,ts,camera,label');
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

  const uploads = await doorUploads(db, body, inserted, now).catch((e) => {
    console.error('door uploads', e instanceof Error ? e.message : String(e));
    return [];
  });

  return json({ ok: true, person, received: events.length + rejected.length, stored: inserted.length, duplicates: events.length - inserted.length, rejected, alert, uploads });
});

// ---------------------------------------------------------------- door clips (migration 0041)

const DOOR_BUCKET = 'door-clips';
const UPLOAD_MAX_AGE_MS = 10 * 60_000;
const DOOR_RETENTION_MS = 14 * 24 * 60 * 60_000;
const FACE_ID = /^[0-9]{1,9}$/;
interface Upload {
  index: number;
  kind: 'clip' | 'face';
  person?: number;
  signedUrl: string;
}

/**
 * For each newly stored unknown event (≤ 10 min old) whose request entry has wantClip and people: signed upload URLs
 * for its clip and one snapshot per person, and the object names + face ids stored on the row. Indexes are positions
 * in the request's `events` array, as the Mac sent them.
 */
async function doorUploads(db: Db, body: Record<string, unknown>, inserted: { id: number; ts: string; label: string }[], now: number): Promise<Upload[]> {
  const raw = Array.isArray(body.events) ? body.events : [];
  const out: Upload[] = [];
  for (let index = 0; index < raw.length; index++) {
    const r = raw[index] as Record<string, unknown> | null;
    if (!r || r.wantClip !== true || r.label !== 'unknown' || !Array.isArray(r.people) || !r.people.length) continue;
    const ts = Date.parse(String(r.ts));
    if (!Number.isFinite(ts) || now - ts > UPLOAD_MAX_AGE_MS) continue;
    const row = inserted.find((x) => x.label === 'unknown' && Date.parse(x.ts) === ts);
    if (!row) continue; // a re-sent batch: nothing new stored, no media wanted
    const day = new Date(ts + 7 * 3_600_000).toISOString().slice(0, 10);
    const clipPath = `${day}/${row.id}.mp4`;
    const people = (r.people as unknown[]).slice(0, 10).map((p, k) => {
      const faces = Array.isArray((p as { faces?: unknown })?.faces) ? ((p as { faces: unknown[] }).faces.map(String).filter((f) => FACE_ID.test(f)).slice(0, 20)) : [];
      return { faces, snapshot: `${day}/${row.id}-p${k}.jpg`, label: null };
    });
    const clip = await db.storage.from(DOOR_BUCKET).createSignedUploadUrl(clipPath, { upsert: true });
    if (clip.error || !clip.data) continue;
    out.push({ index, kind: 'clip', signedUrl: clip.data.signedUrl });
    for (let k = 0; k < people.length; k++) {
      const s = await db.storage.from(DOOR_BUCKET).createSignedUploadUrl(people[k]!.snapshot, { upsert: true });
      if (!s.error && s.data) out.push({ index, kind: 'face', person: k, signedUrl: s.data.signedUrl });
    }
    await db.from('camera_events').update({ clip_path: clipPath, people }).eq('id', row.id);
  }
  return out;
}

let lastPrune = 0;
/** At most hourly: delete clips + snapshots of passes where everyone is named or forgotten, or older than 14 days. */
async function pruneDoorClips(db: Db, now: number): Promise<void> {
  if (now - lastPrune < 60 * 60_000) return;
  lastPrune = now;
  const { data, error } = await db.from('camera_events').select('id,ts,clip_path,people').not('clip_path', 'is', null).limit(500);
  if (error) throw new Error(error.message);
  for (const r of (data ?? []) as { id: number; ts: string; clip_path: string; people: { snapshot?: string; label?: string | null }[] | null }[]) {
    const people = r.people ?? [];
    const done = people.length > 0 && people.every((p) => !!p.label);
    if (!done && now - Date.parse(r.ts) < DOOR_RETENTION_MS) continue;
    const paths = [r.clip_path, ...people.map((p) => p.snapshot).filter((s): s is string => !!s)];
    const rm = await db.storage.from(DOOR_BUCKET).remove(paths);
    if (rm.error) continue;
    await db.from('camera_events').update({ clip_path: null }).eq('id', r.id);
  }
}

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
